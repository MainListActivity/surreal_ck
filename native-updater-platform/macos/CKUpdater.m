#import "CKUpdater.h"
#import <Sparkle/Sparkle.h>
#import <Security/Security.h>

@class CKRequiredUpdater;
static CKRequiredUpdater *activeUpdater;

@interface CKAutomaticDriver : SPUStandardUserDriver
@property(copy) void (^status)(NSString *);
@property(copy) BOOL (^validate)(SUAppcastItem *);
@property BOOL contentValidated;
@end
@implementation CKAutomaticDriver
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    // 不自动接受信息页或付费大版本升级。
    self.contentValidated = self.validate && self.validate(item);
    if (!self.contentValidated) self.status(@"缓存或待安装归档不符合当前可信策略，更新已取消。");
    reply(self.contentValidated ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceSkip);
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    if (!self.contentValidated) {
        self.status(@"尚未验证当前策略对应的归档，拒绝安装。");
        reply(SPUUserUpdateChoiceSkip);
        return;
    }
    self.status(@"正在安装更新并重新启动…");
    reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
    self.status([@"更新失败，应用保持锁定：" stringByAppendingString:error.localizedDescription]);
    acknowledgement();
}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
    self.status(@"未找到策略指定的更新，应用保持锁定。");
    acknowledgement();
}
@end

@interface CKRequiredUpdater : NSObject <SPUUpdaterDelegate>
@property(strong) SPUUpdater *updater;
@property(strong) CKAutomaticDriver *driver;
@property(copy) NSString *version;
@property(strong) NSURL *assetURL;
@property(strong) NSData *verifiedArchive;
@property(strong) NSData *publicKey;
@property(copy) void (^finished)(NSString *);
@property BOOL didFinish;
@property(copy) void (^status)(NSString *);
@end
@implementation CKRequiredUpdater
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    id enclosure = item.propertiesDictionary[@"enclosure"];
    id rawSignature = [enclosure isKindOfClass:NSDictionary.class] ? enclosure[@"sparkle:edSignature"] : nil;
    NSData *signature = [rawSignature isKindOfClass:NSString.class]
        ? [[NSData alloc] initWithBase64EncodedString:rawSignature options:0] : nil;
    BOOL contentBound = signature.length == 64 && self.publicKey.length == 32 &&
        ck_archive_signature_matches(self.publicKey.bytes, self.publicKey.length,
            signature.bytes, signature.length, self.verifiedArchive.bytes, self.verifiedArchive.length);
    BOOL valid = contentBound && !item.deltaUpdate && item.deltaUpdates.count == 0
        && item.contentLength == self.verifiedArchive.length && [item.versionString isEqualToString:self.version] && [item.fileURL isEqual:self.assetURL]
        && !item.informationOnlyUpdate && !item.majorUpgrade;
    if (!valid && error) *error = [NSError errorWithDomain:@"SurrealCK.Update" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Appcast 与已签名策略不一致"}];
    return valid;
}
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
    self.status([@"更新停止，应用保持锁定：" stringByAppendingString:error.localizedDescription]);
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    if (self.didFinish) return;
    self.didFinish = YES;
    NSString *message = error ? [@"更新周期失败，应用保持锁定：" stringByAppendingString:error.localizedDescription]
        : @"更新周期已结束，尚未通过新进程验证，应用保持锁定，可重试。";
    // 完整cycle终止后才释放owner；先退出Sparkle当前调用栈，避免回调中析构。
    dispatch_async(dispatch_get_main_queue(), ^{
        if (activeUpdater == self) activeUpdater = nil;
        self.finished(message);
    });
}
@end
BOOL CKStartRequiredUpdate(NSString *version, NSURL *assetURL, NSString *teamID,
                          NSData *verifiedArchive, void (^status)(NSString *),
                          void (^finished)(NSString *), NSError **error) {
    NSBundle *bundle = NSBundle.mainBundle;
    NSString *key = [bundle objectForInfoDictionaryKey:@"SUPublicEDKey"];
    NSURL *feed = [NSURL URLWithString:[bundle objectForInfoDictionaryKey:@"SUFeedURL"] ?: @""];
    if (!NSThread.isMainThread || activeUpdater || !status || !finished || verifiedArchive.length == 0 || version.length == 0 ||
        teamID.length != 10 || ![[bundle objectForInfoDictionaryKey:@"SUVerifyUpdateBeforeExtraction"] boolValue] || ![assetURL.scheme isEqual:@"https"] || ![feed.scheme isEqual:@"https"] ||
        [[NSData alloc] initWithBase64EncodedString:key ?: @"" options:0].length != 32 ||
        ![[NSFileManager defaultManager] isWritableFileAtPath:bundle.bundlePath]) {
        if (error) *error = [NSError errorWithDomain:@"SurrealCK.Update" code:1 userInfo:@{NSLocalizedDescriptionKey:@"更新桥配置不完整或应用不可写"}];
        return NO;
    }
    // 固定当前宿主的 Developer ID Team。Sparkle 负责更新包 Ed25519 和代码签名校验。
    NSCharacterSet *valid = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
    if ([teamID rangeOfCharacterFromSet:valid.invertedSet].location != NSNotFound) return NO;
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    NSString *rule = [NSString stringWithFormat:@"anchor apple generic and certificate leaf[subject.OU] = \"%@\"", teamID];
    OSStatus result = SecCodeCopySelf(kSecCSDefaultFlags, &code);
    if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)rule, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (requirement) CFRelease(requirement); if (code) CFRelease(code);
    if (result != errSecSuccess) return NO;
    CKRequiredUpdater *owner = [CKRequiredUpdater new];
    owner.version = version; owner.assetURL = assetURL; owner.status = status; owner.finished = finished;
    owner.verifiedArchive = verifiedArchive;
    owner.publicKey = [[NSData alloc] initWithBase64EncodedString:key options:0];
    owner.driver = [[CKAutomaticDriver alloc] initWithHostBundle:bundle delegate:nil];
    owner.driver.status = status;
    __weak CKRequiredUpdater *weakOwner = owner;
    owner.driver.validate = ^BOOL(SUAppcastItem *item) {
        CKRequiredUpdater *strongOwner = weakOwner;
        if (!strongOwner) return NO;
        NSError *validationError = nil;
        return [strongOwner updater:strongOwner.updater shouldProceedWithUpdate:item
            updateCheck:(SPUUpdateCheck)0 error:&validationError];
    };
    owner.updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:owner.driver delegate:owner];
    // 核心每次启动已检查，不让Sparkle自己的周期在旧授权下再次下载。
    owner.updater.automaticallyChecksForUpdates = NO;
    owner.updater.automaticallyDownloadsUpdates = NO;
    if (![owner.updater startUpdater:error]) return NO;
    activeUpdater = owner;
    status(@"平台更新检查已启动，应用保持锁定。");
    [owner.updater checkForUpdates];
    return YES;
}

int32_t ck_start_required_update(const char *version, const char *url, const char *publisher,
                                 const uint8_t *bytes, size_t length, uint64_t generation, CKStatusCallback status) {
    if (!version || !url || !publisher || !bytes || length == 0 || !status) return 1;
    NSString *v = [NSString stringWithUTF8String:version];
    NSString *u = [NSString stringWithUTF8String:url];
    NSString *p = [NSString stringWithUTF8String:publisher];
    if (!v || !u || !p) return 1;
    NSData *archive = [NSData dataWithBytes:bytes length:length];
    dispatch_async(dispatch_get_main_queue(), ^{
        NSError *error = nil;
        BOOL started = CKStartRequiredUpdate(v, [NSURL URLWithString:u], p, archive,
            ^(NSString *message) { status(generation, false, message.UTF8String); },
            ^(NSString *message) { status(generation, true, message.UTF8String); }, &error);
        if (!started) status(generation, true, (error.localizedDescription ?: @"更新桥无法启动，应用保持锁定。").UTF8String);
    });
    // 只代表参数已复制并排入主队列，实际启动/失败通过状态回调。
    return 0;
}
