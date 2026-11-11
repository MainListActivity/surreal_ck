#import <Foundation/Foundation.h>
// 仅由通过核心校验的启动门调用。必须在主线程、业务界面尚未挂载时调用。
// 成功只代表 Sparkle 已开始工作；不代表安装完成，也不得解锁旧客户端。
BOOL CKStartRequiredUpdate(NSString *version, NSURL *assetURL, NSString *teamID,
                          NSData *verifiedArchive, void (^status)(NSString *message),
                          void (^finished)(NSString *message), NSError **error);

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef void (*CKStatusCallback)(uint64_t generation, bool terminal, const char *message);
int32_t ck_start_required_update(const char *version, const char *url, const char *publisher,
                                 const uint8_t *bytes, size_t length, uint64_t generation, CKStatusCallback status);
// Rust ring Ed25519, only called with NSData-owned buffers.
bool ck_archive_signature_matches(const uint8_t *key, size_t key_len, const uint8_t *signature,
                                  size_t signature_len, const uint8_t *bytes, size_t length);
