# 来源资料契约

支持 ABIF v101 目录格式，目录项标签+编号为局部身份。数据大小 dataSize<=4 时 dataOffset 字段本身内联保存值（location 标记为 `entry@偏移:dataOffset`），否则 dataOffset 才指向外置字节区间（location 标记为 `bytes@起..止`）；目录是大端。短数据不能一概按文件偏移读取。PBAS/PCON/PLOC 同编号才属于同一次调用，编号即调用版本；FWO_ 表示 DATA9..12 的染料顺序，染料含义只按该来源声明映射；其他 DATA 编号保留原始目录，dye 记为 null 并以 `trace_dye_undeclared` 问题说明，不按数组顺序猜同一通道。base-call 的 value 包含 version、sequence、qualities、peakLocations（来源中缺失的组件不出现）与 pairing；pairing 含 complete、matched、lengths、present、truncatedComponents 及配对完整性。trace-channel 含 dye、directoryNumber、sampleCount、dyeBasis。同次调用长度冲突保留为 `base_call_length_conflict` 问题，各数组保持来源长度，不截到最短假装配对。partial 截断外置数据时以 `truncated_external_data` 报告对应目录项及期望/实际字节范围，不默认为零；截断组件不取值，只保留出处。

未知目录项不阻塞已知条目，以 `abif-directory-entry` 记录保留标签、编号、类型、元素数、数据大小与 `supported:false`，其 provenance 指向真实收件中的具体位置，可回查原文。本服务只接收来源中既有的调用与轨迹，不另作判峰、比对或检测结论；未列出的标准扩展允许明确标识未支持，不允许假称已解释。

每条已解释资料均可回到真实来源收件和具体位置：records 每项含 kind、key、value、provenance，provenance 是 `{receiptId, location}` 数组，location 采用可复查的 ABIF 定位（内联字段或字节区间）。交付索引（delivery JSON）本身与其每个 roots 原文分别保留独立收件；单个 root 领取失败时保留已领原文并登记 `source_response_*` 问题，缺件不等于来源明确删除。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。
