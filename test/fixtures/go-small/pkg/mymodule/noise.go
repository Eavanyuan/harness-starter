package mymodule

// 噪声夹具：函数体里的字符串**不是** import。
//
// 旧实现用「行首 + 引号」扫全文，`return "..."` 这种行会被当成一条 import：
// imports_parsed 虚高，而字符串恰好长得像模块路径时还会造出假边。
// 这个文件被断言为"一条 import 都不贡献"。
func Path() string {
	return "not/an/import"
}

func Alias() string {
	var p = "not/an/import"
	_ = p
	return p
}
