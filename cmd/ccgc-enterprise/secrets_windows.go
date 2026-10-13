//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const cryptProtectUIForbidden = 0x1

type dataBlob struct {
	size uint32
	data *byte
}

var (
	crypt32            = syscall.NewLazyDLL("crypt32.dll")
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	cryptProtectData   = crypt32.NewProc("CryptProtectData")
	cryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	localFree          = kernel32.NewProc("LocalFree")
)

func blob(value []byte) dataBlob {
	if len(value) == 0 {
		return dataBlob{}
	}
	return dataBlob{size: uint32(len(value)), data: &value[0]}
}

func securePath(id string) (string, error) {
	if len(id) != 64 || !validAdmission(id) {
		return "", errors.New("invalid credential identifier")
	}
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		return "", errors.New("LOCALAPPDATA is unavailable")
	}
	return filepath.Join(root, "CCGC", "credentials", id+".bin"), nil
}

func secureSet(id, value string) error {
	path, err := securePath(id)
	if err != nil {
		return err
	}
	inputBytes := []byte(value)
	input := blob(inputBytes)
	var output dataBlob
	result, _, callErr := cryptProtectData.Call(
		uintptr(unsafe.Pointer(&input)),
		0, 0, 0, 0,
		cryptProtectUIForbidden,
		uintptr(unsafe.Pointer(&output)),
	)
	if result == 0 {
		return callErr
	}
	defer localFree.Call(uintptr(unsafe.Pointer(output.data)))
	encrypted := append([]byte(nil), unsafe.Slice(output.data, output.size)...)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return os.WriteFile(path, encrypted, 0600)
}

func secureGet(id string) (string, error) {
	path, err := securePath(id)
	if err != nil {
		return "", err
	}
	encrypted, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("credential is unavailable in Windows DPAPI storage")
	}
	input := blob(encrypted)
	var output dataBlob
	result, _, callErr := cryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&input)),
		0, 0, 0, 0, 0,
		cryptProtectUIForbidden,
		uintptr(unsafe.Pointer(&output)),
	)
	if result == 0 {
		return "", callErr
	}
	defer localFree.Call(uintptr(unsafe.Pointer(output.data)))
	return string(append([]byte(nil), unsafe.Slice(output.data, output.size)...)), nil
}

func secureDelete(id string) error {
	path, err := securePath(id)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
