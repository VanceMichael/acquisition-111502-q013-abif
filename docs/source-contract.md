# 来源资料契约

支持 ABIF v101 目录格式，目录项标签+编号为局部身份。数据大小<=4时 dataOffset 字段本身保存值，否则指向外置字节；目录是大端。PBAS/PCON/PLOC 同编号才属于同一次调用，FWO_ 表示 DATA9..12 的染料顺序；其他 DATA 编号保留原始目录，不猜同一通道。base-call 的 value 包含 version、sequence、qualities、peakLocations 及配对完整性；trace-channel 含 dye、directoryNumber、sampleCount。未知类型不阻塞已知条目，但必须留出处。partial 截断外置数据，应报告对应目录项而非默认为零。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。
