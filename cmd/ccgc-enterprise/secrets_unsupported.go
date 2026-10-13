//go:build !darwin && !windows

package main

import "errors"

func secureGet(string) (string, error) {
	return "", errors.New("credential storage is supported only on macOS and Windows")
}

func secureSet(string, string) error {
	return errors.New("credential storage is supported only on macOS and Windows")
}

func secureDelete(string) error {
	return errors.New("credential storage is supported only on macOS and Windows")
}
