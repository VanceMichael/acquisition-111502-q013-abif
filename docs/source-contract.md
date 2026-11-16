# 来源资料契约

支持 ABIF v101 目录格式，目录项标签+编号为局部身份。数据大小<=4时 dataOffset 字段本身保存值，否则指向外置字节；目录是大端。PBAS/PCON/PLOC 同编号才属于同一次调用，FWO_ 表示 DATA9..12 的染料顺序；其他 DATA 编号保留原始目录，不猜同一通道。base-call 的 value 包含 version、sequence、qualities、peakLocations 及配对完整性；trace-channel 含 dye、directoryNumber、sampleCount。未知类型不阻塞已知条目，但必须留出处。partial 截断外置数据，应报告对应目录项而非默认为零。

base-call 的 key 以「收件 + CALL.编号」标识一次调用；sequence、qualities、peakLocations 各自在 sources 下记录 receiptId、location、entryLocation、tag、number，provenance 同样逐项列出。配对只在同一编号内进行，不做跨编号拼接；同一编号内各标签长度不一致时 complete=false、pairing.conflict=true、pairing.lengths 保留原长度，并另记 call_length_conflict issue，不截到最短。缺失的标签写 null 并列入 pairing.missing。

trace-channel 的染料只由 FWO_ 的四个字符按位置声明：FWO_[0..3] 依次对应 DATA9..12。没有 FWO_ 或 DATA 编号不在 9..12 时，该目录项以 directory-entry 记录（status=unmapped-channel），不按数组顺序推断通道。样本值与染料字符分别出自 DATA 目录项与 FWO_ 目录项，两者都进入 provenance。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。directory-entry 记录保留每个目录项的原标签、编号、类型、大小、存储方式与状态，未知或未使用目录项也可按字节位置回查。
