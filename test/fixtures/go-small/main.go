package main

import (
	"flag"
	"tdc-go/pkg/controller"
)

func main() {
	flag.Parse()
	_ = controller.Reconcile()
}
