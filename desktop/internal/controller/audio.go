package controller

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
)

type AudioConverter interface {
	Convert(ctx context.Context, inputPath, outputPath string) (float64, error)
}

type FFmpegConverter struct {
	Binary string
}

func (c FFmpegConverter) Convert(ctx context.Context, inputPath, outputPath string) (float64, error) {
	binaryPath := c.Binary
	if binaryPath == "" {
		binaryPath = "ffmpeg"
	}
	convertCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(
		convertCtx,
		binaryPath,
		"-y",
		"-i", inputPath,
		"-ar", "16000",
		"-ac", "1",
		"-sample_fmt", "s16",
		outputPath,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		return 0, fmt.Errorf("ffmpeg: %w: %s", err, string(output))
	}
	duration, err := wavDuration(outputPath)
	if err != nil {
		return 0, err
	}
	return duration, nil
}

func wavDuration(path string) (float64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	header := make([]byte, 12)
	if _, err := io.ReadFull(file, header); err != nil {
		return 0, err
	}

	if string(header[0:4]) != "RIFF" || string(header[8:12]) != "WAVE" {
		return 0, fmt.Errorf("not a WAV file")
	}

	var byteRate uint32
	var dataSize uint32
	for {
		chunkHeader := make([]byte, 8)
		if _, err := io.ReadFull(file, chunkHeader); err != nil {
			return 0, err
		}
		chunkID := string(chunkHeader[0:4])
		chunkSize := binary.LittleEndian.Uint32(chunkHeader[4:8])
		switch chunkID {
		case "fmt ":
			chunk := make([]byte, chunkSize)
			if _, err := io.ReadFull(file, chunk); err != nil {
				return 0, err
			}
			if len(chunk) < 12 {
				return 0, fmt.Errorf("invalid WAV fmt chunk")
			}
			byteRate = binary.LittleEndian.Uint32(chunk[8:12])
		case "data":
			dataSize = chunkSize
			if byteRate == 0 {
				if _, err := file.Seek(int64(chunkSize), io.SeekCurrent); err != nil {
					return 0, err
				}
			}
		default:
			if _, err := file.Seek(int64(chunkSize), io.SeekCurrent); err != nil {
				return 0, err
			}
		}

		if chunkSize%2 == 1 {
			if _, err := file.Seek(1, io.SeekCurrent); err != nil {
				return 0, err
			}
		}

		if byteRate > 0 && dataSize > 0 {
			return float64(dataSize) / float64(byteRate), nil
		}
	}
}
