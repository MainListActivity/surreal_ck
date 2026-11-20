# 062 本地候选数据库合同

这是已在本地固定 fork 上验证的规则候选，不是生产准入证明。`availability()`保持关闭，不接生产、不改变客户端媒体路径。必须先应用061身份保护；Owner/root是可信控制面，规则不防御恶意Owner。此次测试使用真实RECORD身份和最小本地成员fixture，不替代生产JWKS、scope exchange、完整模板与持久存储验证。

## SDK操作

用已认证RECORD会话；参数绑定而非拼接SQL。`RecordId('native_signal', id)`、`RecordId('user', member)`保留类型。sender来自当前认证身份，不接受UI自报、peer token或SDP里的成员声明。id、nonce、generation分别由CSPRNG生成32字节小写hex。服务器校验格式，不证明客户端随机熵。

- create：`db.create(record).content({workspace, sender, recipient, nonce, generation, offer, offer_hash, status:'pending'})`。offer是ASCII JSON、最多49152字节，恰好type/sdp两个字段，type=offer，含协议要求的SDP开头、媒体行、fingerprint、ICE参数。offer_hash为原始JSON字符串SHA256，服务器重新核对。created_at/expires_at由服务器强制生成，客户端值不能延长寿命。
- list/read：SDK select或SELECT native_signal；服务器仅对仍有效且双方活跃的参与者开放。列表只投影id/sender/expires_at，未经验证不要把列表对象当认证媒体证明。查询空结果和权限错误均按失败处理。
- accept/reject：接收者更新status为accepted/rejected，必须先有用户明确接受意图。不同时写answer。
- answer：接收者在accepted后单次更新status=answered、answer=ASCII JSON(type=answer)。服务器拒绝抢答、重复answer和覆盖。
- end：双方均可把pending/accepted/answered改ended。rejected/ended不能复活；DELETE不允许。

所有修改使用固定参数化UPDATE，并在WHERE逐项匹配调用方保存的完整绑定：id/workspace/sender/recipient/nonce/generation/offer_hash/expires_at。空数组不算成功。接收返回值后再次比较完整绑定和服务器时间，再构造内部AuthenticatedOffer/Answer；不得为JSON输入开放公共构造函数。新workspace/登录/连接generation切换时销毁旧binding和旧回调。数据库永久保留同sender的nonce/generation唯一性；不得用清理任务删除邀请后声称仍防重放。

## 服务器边界

- 两端必须为当前user表中存在、kind=human且disabled_at=NONE的成员。每次读取/写入查询当前记录，不依赖缓存的$auth资料。
- workspace必须等于session::db()。完整绑定不可修改，表权限绑定真实$auth.id。
- 每sender最多每10秒一个邀请；事件与创建同事务，更新仅控制面可见的固定节流行，并由唯一索引与写冲突串行化。并发失败必须等冷却后才重试，不忙循环。
- created_at/expires_at使用字段VALUE由服务器生成；由于time::now()在一次语句内也可能变化，两个时间可相差120秒加微秒级字段求值差。准入以expires_at为唯一期限，不用客户端时钟替代。若要求严格从同一个时间点计算120秒，应先补引擎级固定事务时间契约，不能伪称两时间完全一致。
- 不支持LIVE、ICE逐候选写入、心跳流、媒体、聊天正文、文件、token。SCHEMAFULL不意味着任意文本不能藏进SDP；客户端必须仅传WebRTC生成的SDP，不将此表作为通用消息通道。
- 无表清理/配额运营策略或生产请求层DoS证明。10秒邀请限频不是读频控；客户端轮询至少3秒，数据库没有对SELECT次数计量。不要把该客户端轮询约定称作服务器强制频控。
- 事件内跨表写入权限、并发冲突和回滚为当前fork的实测行为；升级后必须重跑，不只看CLI解析成功。

## 重现

独立依赖目录只需Bun、surrealdb SDK，禁止整仓安装。测试时临时将该目录node_modules链接到native-signaling/node_modules，结束删除链接。设置SURREAL_TEST_BINARY为固定fork路径，用Bun运行native-signaling/tests/fork-rules.ts。测试自起随机loopback端口memory实例，只root建schema/fixture/撤销fixture，业务全部RECORD；不读取.env、生产凭证，不生成grant。真实等待121秒验证过期。

固定运行时：3.3.0-native-quota.1+sha.f30704bce914。SQL使用官方@surrealdb/surql-fmt 0.1.0-beta.3格式化并CLI validate。完整结果见同目录FORK-RULES-RESULT.md。
