package main

import (
	"os"

	"github.com/jacebenson/jsn/internal/cli"
)

func main() {
	if err := cli.Execute(); err != nil {
		os.Exit(1)
	}
}
