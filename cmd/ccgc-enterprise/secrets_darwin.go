//go:build darwin

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

func keychainService(id string) (string, error) {
	if len(id) != 64 || !validAdmission(id) {
		return "", errors.New("invalid credential identifier")
	}
	return "ccgc.remote." + id, nil
}

func secureGet(id string) (string, error) {
	service, err := keychainService(id)
	if err != nil {
		return "", err
	}
	output, err := exec.Command("/usr/bin/security", "find-generic-password", "-a", "owner", "-s", service, "-w").Output()
	if err != nil {
		return "", errors.New("credential is unavailable in macOS Keychain")
	}
	return strings.TrimSpace(string(output)), nil
}

func secureSet(id, value string) error {
	service, err := keychainService(id)
	if err != nil {
		return err
	}
	command := exec.Command("/usr/bin/security", "-i")
	command.Stdin = bytes.NewBufferString(fmt.Sprintf("add-generic-password -U -a owner -s %s -w %s\n", service, value))
	if err := command.Run(); err != nil {
		return errors.New("could not save credential to macOS Keychain")
	}
	stored, err := secureGet(id)
	if err != nil || stored != value {
		return errors.New("macOS Keychain did not persist the credential")
	}
	return nil
}

func secureDelete(id string) error {
	service, err := keychainService(id)
	if err != nil {
		return err
	}
	err = exec.Command("/usr/bin/security", "delete-generic-password", "-a", "owner", "-s", service).Run()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 44 {
			return nil
		}
		return errors.New("could not remove credential from macOS Keychain")
	}
	return nil
}
