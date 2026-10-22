//go:build ignore

package main

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

func main() {
	input, err := os.Open("menubar.png")
	must(err)
	base, err := png.Decode(input)
	must(err)
	must(input.Close())
	bounds := base.Bounds()
	recording := image.NewNRGBA(bounds)
	processing := image.NewNRGBA(bounds)
	stopping := image.NewNRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			var recAlpha, ringAlpha float64
			const samples = 8
			for sy := range samples {
				for sx := range samples {
					px := float64(x) + (float64(sx)+0.5)/samples
					py := float64(y) + (float64(sy)+0.5)/samples
					if math.Hypot(px-18, py-18) <= 8 {
						recAlpha++
					}
					dx, dy := px-18, py-18
					radius := math.Hypot(dx, dy)
					angle := math.Atan2(dy, dx)
					if radius >= 11 && radius <= 14 && (angle < -0.7 || angle > 0.2) {
						ringAlpha++
					}
				}
			}
			recording.SetNRGBA(x, y, color.NRGBA{R: 0xe5, G: 0x48, B: 0x4d, A: uint8(math.Round(recAlpha * 255 / (samples * samples)))})
			processing.SetNRGBA(x, y, color.NRGBA{A: uint8(math.Round(ringAlpha * 255 / (samples * samples)))})
			stopping.SetNRGBA(x, y, color.NRGBA{R: 0xf0, G: 0x8c, B: 0x2b, A: uint8(math.Round(recAlpha * 255 / (samples * samples)))})
		}
	}
	write("menubar-recording.png", recording)
	write("menubar-processing.png", processing)
	write("menubar-stopping.png", stopping)
	// Точки-индикаторы для пунктов меню: круг на весь холст, размер задаёт меню.
	for name, tint := range map[string]color.NRGBA{
		"red":    {R: 0xe5, G: 0x48, B: 0x4d},
		"blue":   {R: 0x3e, G: 0x8e, B: 0xf7},
		"green":  {R: 0x30, G: 0xa4, B: 0x6c},
		"orange": {R: 0xf0, G: 0x8c, B: 0x2b},
		"gray":   {R: 0x8e, G: 0x8e, B: 0x93},
	} {
		dot := image.NewNRGBA(bounds)
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				var alpha float64
				const samples = 8
				for sy := range samples {
					for sx := range samples {
						px := float64(x) + (float64(sx)+0.5)/samples
						py := float64(y) + (float64(sy)+0.5)/samples
						if math.Hypot(px-18, py-18) <= 17 {
							alpha++
						}
					}
				}
				tint.A = uint8(math.Round(alpha * 255 / (samples * samples)))
				dot.SetNRGBA(x, y, tint)
			}
		}
		write("indicator-"+name+".png", dot)
	}
}

func write(path string, img image.Image) {
	output, err := os.Create(path)
	must(err)
	must(png.Encode(output, img))
	must(output.Close())
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
