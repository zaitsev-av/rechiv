//go:build darwin && cgo

package extensiondist

/*
#include <stdio.h>
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"os"
	"unsafe"
)

func replaceDirectory(staged, target string) error {
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		return os.Rename(staged, target)
	} else if err != nil {
		return err
	}

	from := C.CString(staged)
	to := C.CString(target)
	defer C.free(unsafe.Pointer(from))
	defer C.free(unsafe.Pointer(to))

	// rename не заменяет непустой каталог; RENAME_SWAP не оставляет Chrome без целого дерева.
	if result, errno := C.renamex_np(from, to, C.RENAME_SWAP); result != 0 {
		return fmt.Errorf("renamex_np: %w", errno)
	}
	// После обмена staged указывает на прежнюю версию.
	return os.RemoveAll(staged)
}
