#!/usr/bin/env python3
"""实验Android宿主封装：保留NSH资源/原DEX，合并受审Java/manifest和已构建JNI库。
不下载依赖、不安装到设备、不创建key；只使用显式提供的现有签名身份。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import struct
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ANDROID = "http://schemas.android.com/apk/res/android"
A = "{" + ANDROID + "}"
ET.register_namespace("android", ANDROID)
JNI_SYMBOL = "Java_top_maplayer_collaboration_update_UpdaterInitProvider_initialize"


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def capture(args):
    return run(args, stdout=subprocess.PIPE, text=True).stdout


def resource_symbols(dump):
    """使用真实SDK/输入APK资源表恢复符号，不硬编码版本相关theme/flag数值。"""
    package, current, kind = None, None, None
    symbols, attributes = {}, {}
    for line in dump.splitlines():
        match = re.match(r"Package name=(\S+) id=", line)
        if match:
            package = match[1]
        match = re.match(r"\s+resource (0x[0-9a-fA-F]+) (\S+)", line)
        if match:
            number, name = int(match[1], 16), match[2]
            symbols[number] = "@" + package + ":" + name
            current = name.removeprefix("attr/") if name.startswith("attr/") else None
            kind = None
        match = re.search(r"\(attr\) type=(flags|enum)(?:\s|$)", line)
        if current and match:
            kind = match[1]
            attributes[current] = (kind, {})
        match = re.match(r"\s+(\w+)\(0x[0-9a-fA-F]+\)=(0x[0-9a-fA-F]+)", line)
        if current and kind and match:
            attributes[current][1][match[1]] = int(match[2], 16)
    return symbols, attributes


def decode_flags(number, kind, values):
    exact = sorted(name for name, value in values.items() if value == number)
    if exact:
        return exact[0]
    if kind == "enum":
        raise ValueError(f"Unknown enum value: {number:#x}")
    remaining, names = number, []
    # 包含重叠位组的flag（例如softInputMode）优先选最具体的完整值。
    for name, value in sorted(values.items(), key=lambda pair: (pair[1].bit_count(), pair[1]), reverse=True):
        if value and remaining & value == value:
            names.append(name)
            remaining &= ~value
    if remaining or not names:
        raise ValueError(f"Unknown flag bits: {number:#x}")
    return "|".join(names)


def normalize_manifest(xml, symbols, attributes):
    # 某些JDK在stdout先写统一日志（例如容器cgroup告警）；只接受可识别日志前缀。
    marker = xml.find("<?xml")
    if marker > 0:
        prefix = xml[:marker]
        if all(not line.strip() or re.fullmatch(r"\[[^\n]+\].*", line) for line in prefix.splitlines()):
            xml = xml[marker:]
        else:
            raise ValueError(f"Unexpected apkanalyzer stdout prefix: {prefix[:200]!r}")
    root = ET.fromstring(xml)
    for node in root.iter():
        for name, value in list(node.attrib.items()):
            if value.startswith("@ref/0x"):
                resource = int(value[len("@ref/"):], 16)
                if resource not in symbols:
                    raise ValueError(f"Resource name unavailable: {value}")
                node.set(name, symbols[resource])
            elif value.startswith("0x") and name.startswith(A):
                key = name[len(A):]
                if key in attributes:
                    kind, flags = attributes[key]
                    node.set(name, decode_flags(int(value, 16), kind, flags))
    return root


AUTH_PREFIX = "top.maplayer.collaboration.auth."
AUTH_CALLBACK = AUTH_PREFIX + "AuthCallbackActivity"
AUTH_PROVIDER = AUTH_PREFIX + "AuthInitProvider"


def verify_auth_component(component):
    name = component.get(A + "name")
    if name == AUTH_CALLBACK:
        if component.tag != "activity" or component.attrib != {
            A + "name": AUTH_CALLBACK, A + "exported": "true",
            A + "noHistory": "true", A + "excludeFromRecents": "true",
        }:
            raise ValueError("OAuth callback activity attributes differ from audited ingress")
        filters = list(component)
        if len(filters) != 1 or filters[0].tag != "intent-filter" or filters[0].attrib:
            raise ValueError("OAuth callback requires one exact intent filter")
        entries = [(node.tag, tuple(sorted(node.attrib.items()))) for node in filters[0]]
        expected = [(tag, ((A + key, value),)) for tag, key, value in [
            ("action", "name", "android.intent.action.VIEW"),
            ("category", "name", "android.intent.category.DEFAULT"),
            ("category", "name", "android.intent.category.BROWSABLE"),
            ("data", "scheme", "top.maplayer.collaboration"),
        ]]
        if sorted(entries) != sorted(expected) or any(list(node) for node in filters[0]):
            raise ValueError("OAuth callback filter differs from audited scheme")
    elif name == AUTH_PROVIDER:
        if component.tag != "provider" or component.attrib != {
            A + "name": AUTH_PROVIDER, A + "exported": "false",
            A + "authorities": "top.maplayer.collaboration.auth-init", A + "initOrder": "90",
        } or list(component):
            raise ValueError("OAuth provider must be private and match audited initialization")
    else:
        raise ValueError("Unexpected OAuth manifest component")


def verify_auth_manifest(root, enabled):
    components = [node for node in root.find("application")
                  if node.get(A + "name", "").startswith(AUTH_PREFIX)]
    if not enabled and components:
        raise ValueError("OAuth manifest requires explicit --enable-experimental-oauth")
    if enabled:
        if sorted(node.get(A + "name") for node in components) != sorted([AUTH_CALLBACK, AUTH_PROVIDER]):
            raise ValueError("OAuth opt-in requires both callback and private initialization provider")
        for component in components:
            verify_auth_component(component)


def verify_manifest_dex(root, classes, oauth_enabled):
    required = {"L" + node.get(A + "name").replace(".", "/") + ";"
                for node in root.find("application")
                if node.get(A + "name", "").startswith("top.maplayer.collaboration.")}
    if oauth_enabled:
        required.update("Ltop/maplayer/collaboration/auth/" + name + ";" for name in ("AuthBridge", "AuthUri"))
    if required - classes:
        raise ValueError("Actual DEX lacks manifest/bridge classes: " + ", ".join(sorted(required - classes)))


def merge_fragment(root, fragment, oauth_enabled=False):
    package = root.get("package")
    application = root.find("application")
    if application is None:
        raise ValueError("Input APK has no application")
    text = Path(fragment).read_text().replace("${applicationId}", package)
    source = ET.fromstring(text)
    if source.tag != "manifest" or source.attrib:
        raise ValueError("Fragment cannot override manifest identity")
    for child in source:
        if child.tag == "uses-permission":
            if set(child.attrib) != {A + "name"}:
                raise ValueError("Only named permission declarations are accepted")
            if not any(item.get(A + "name") == child.get(A + "name") for item in root.findall("uses-permission")):
                root.append(child)
        elif child.tag == "application":
            if child.attrib:
                raise ValueError("Fragment cannot override application properties")
            for component in child:
                if component.tag not in ("provider", "receiver", "service", "activity"):
                    raise ValueError("Unexpected component in manifest fragment")
                if component.get(A + "name", "").startswith(AUTH_PREFIX):
                    if not oauth_enabled:
                        raise ValueError("OAuth components require explicit opt-in")
                    verify_auth_component(component)
                elif component.get(A + "exported") != "false":
                    raise ValueError("Experimental host components must be non-exported")
                name = component.get(A + "name")
                if not name or any(item.get(A + "name") == name for item in application):
                    raise ValueError("Duplicate or unnamed host component")
                application.append(component)
        else:
            raise ValueError("Unexpected manifest fragment element")
    return root


def signer_certificates(output):
    certificates = set(re.findall(r"^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$", output, re.MULTILINE))
    if not certificates:
        raise ValueError("APK signer certificate is unavailable")
    return {value.lower() for value in certificates}


def verify_updater_host(root, oauth_enabled, collaboration=False):
    """严格验证所选宿主的完整组件，不将缺桥的 APK 当作完整客户端。"""
    if oauth_enabled != collaboration:
        raise ValueError("OAuth ingress must match the selected host mode")
    allowed = {
        "top.maplayer.collaboration.update.UpdaterInitProvider",
        "top.maplayer.collaboration.update.UpdateResultReceiver",
        "top.maplayer.collaboration.documents.DocumentInitProvider",
        "top.maplayer.collaboration.documents.DocumentActivity",
    }
    if collaboration:
        allowed.update({AUTH_CALLBACK, AUTH_PROVIDER,
            "top.maplayer.collaboration.media.MediaInitProvider",
            "top.maplayer.collaboration.media.NativeCallActivity",
            "top.maplayer.collaboration.media.NativeCaptureService"})
    required = allowed
    seen = set()
    for component in root.findall("application/*"):
        name = component.get(A + "name", "")
        if name.startswith("top.maplayer.collaboration."):
            if name not in allowed or (name != AUTH_CALLBACK and component.get(A + "exported") != "false"):
                raise ValueError("Unexpected standard updater host component: " + name)
            if name.startswith(AUTH_PREFIX):
                verify_auth_component(component)
            seen.add(name)
    if not required <= seen:
        raise ValueError("Standard updater host is missing required components")


def apk_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(set(names)) != len(names):
            raise ValueError("Duplicate ZIP entries")
        if any(name.startswith("/") or ".." in Path(name).parts for name in names):
            raise ValueError("Unsafe APK ZIP path")
        return names


def required_jni_symbols(fragments):
    required = {JNI_SYMBOL, "JNI_OnLoad", "Java_com_longbridge_nsh_Native_runRust"}
    for fragment in fragments:
        for provider in ET.parse(fragment).getroot().findall("application/provider"):
            name = provider.get(A + "name")
            if name == AUTH_PROVIDER:
                required.update({"Java_top_maplayer_collaboration_auth_AuthInitProvider_initialize",
                                 "Java_top_maplayer_collaboration_auth_AuthBridge_callback"})
            if name == "top.maplayer.collaboration.documents.DocumentInitProvider":
                required.add("Java_top_maplayer_collaboration_documents_DocumentInitProvider_initialize")
            if name == "top.maplayer.collaboration.media.MediaInitProvider":
                required.add("Java_top_maplayer_collaboration_media_MediaInitProvider_initialize")
                required.update("Java_top_maplayer_collaboration_media_MediaBridge_" + method
                                for method in ("nativeFrame", "nativeState", "nativeError", "nativeClosed"))
    return required


def verify_jni_exports(exported, required, abi):
    names = {line.split()[-1] for line in exported.splitlines()
             if "GLOBAL" in line and " UND " not in line and line.split()}
    for symbol in sorted(required):
        if symbol not in names:
            raise ValueError(f"Native library lacks exported symbol: {abi}: {symbol}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--enable-experimental-host", action="store_true")
    mode.add_argument("--enable-updater-host", action="store_true", help="Updater and document host only")
    mode.add_argument("--enable-collaboration-host", action="store_true", help="Complete collaboration, OAuth, media and updater host")
    p.add_argument("--enable-experimental-oauth", action="store_true", help="Explicit test-only callback ingress; never configures an identity provider")
    p.add_argument("--input-apk", type=Path, required=True)
    p.add_argument("--output-apk", type=Path, required=True)
    p.add_argument("--sdk", type=Path, required=True)
    p.add_argument("--native-lib", action="append", required=True, help="ABI=/absolute/libnsh.so")
    p.add_argument("--java-source-dir", type=Path, action="append", required=True)
    p.add_argument("--manifest-fragment", type=Path, action="append", required=True)
    p.add_argument("--keystore-existing", type=Path, required=True)
    p.add_argument("--key-alias", required=True)
    p.add_argument("--test-signing", action="store_true", help="Only existing standard Android debug key; no key generation")
    args = p.parse_args()
    if not args.input_apk.is_file() or not args.keystore_existing.is_file():
        p.error("Input APK and existing keystore must exist")
    if args.output_apk.exists() or args.output_apk.resolve() == args.input_apk.resolve():
        p.error("Output must be a new APK path")
    evidence_path = args.output_apk.with_suffix('.verification.json')
    if evidence_path.exists():
        p.error("Package verification evidence must be a new path")
    if args.test_signing and args.key_alias != "androiddebugkey":
        p.error("Test signing only supports the standard debug alias")
    if not args.test_signing and not os.environ.get("NSH_KEYSTORE_PASSWORD"):
        p.error("Release signing requires NSH_KEYSTORE_PASSWORD in environment")
    tools = args.sdk / "build-tools/35.0.1"
    jar = args.sdk / "platforms/android-35/android.jar"
    analyzer = args.sdk / "cmdline-tools/latest/bin/apkanalyzer"
    names = apk_entries(args.input_apk)
    libs = {}
    for spec in args.native_lib:
        abi, path = spec.split("=", 1)
        if abi not in ("arm64-v8a", "x86_64") or abi in libs:
            p.error("Only unique arm64-v8a/x86_64 libraries are accepted")
        file = Path(path)
        if not file.is_file():
            p.error("Native library does not exist")
        header = file.read_bytes()[:64]
        if len(header) < 64 or header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != {"arm64-v8a":183,"x86_64":62}[abi]:
            raise ValueError(f"Native ELF architecture mismatch: {abi}")
        # 实际动态符号而非源码中的函数名。
        readelf = args.sdk / "ndk/29.0.14206865/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
        if not readelf.exists():
            readelf = Path("llvm-readelf")
        exported = capture([readelf, "--dyn-syms", "--wide", file])
        verify_jni_exports(exported, required_jni_symbols(args.manifest_fragment), abi)
        libs[abi] = file
    existing_abis = {name.split("/")[1] for name in names if re.fullmatch(r"lib/[^/]+/libnsh\.so", name)}
    if set(libs) != existing_abis:
        p.error("Replace every original NSH ABI; do not mix old and new native hosts")
    sdk_symbols, attributes = resource_symbols(capture([tools / "aapt2", "dump", "resources", jar]))
    own_symbols, _ = resource_symbols(capture([tools / "aapt2", "dump", "resources", args.input_apk]))
    root = normalize_manifest(capture([analyzer, "manifest", "print", args.input_apk]), sdk_symbols | own_symbols, attributes)
    if root.get("package") != "top.maplayer.collaboration":
        p.error("Wrong application identity")
    for fragment in args.manifest_fragment:
        merge_fragment(root, fragment, args.enable_experimental_oauth)
    if args.enable_updater_host or args.enable_collaboration_host:
        verify_updater_host(root, args.enable_experimental_oauth, args.enable_collaboration_host)
    verify_auth_manifest(root, args.enable_experimental_oauth)
    if args.enable_experimental_oauth:
        for abi, file in libs.items():
            verify_jni_exports(capture([readelf, "--dyn-syms", "--wide", file]),
                {"Java_top_maplayer_collaboration_auth_AuthInitProvider_initialize",
                 "Java_top_maplayer_collaboration_auth_AuthBridge_callback"}, abi)
    sources = sorted({file.resolve() for directory in args.java_source_dir for file in directory.rglob("*.java")})
    if not sources:
        p.error("No Java sources")
    args.output_apk.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="android-host-", dir=args.output_apk.parent) as temp:
        work = Path(temp)
        xml = work / "AndroidManifest.xml"
        ET.ElementTree(root).write(xml, encoding="utf-8", xml_declaration=True)
        manifest_apk = work / "manifest.apk"
        run([tools / "aapt2", "link", "--manifest", xml, "-I", jar, "-I", args.input_apk, "-o", manifest_apk])
        classes, dex = work / "classes", work / "dex"
        classes.mkdir(); dex.mkdir()
        run(["java", "com.sun.tools.javac.Main", "-source", "8", "-target", "8", "-Xlint:all,-options", "-Werror", "-bootclasspath", str(jar) + os.pathsep + str(tools / "core-lambda-stubs.jar"), "-d", classes, *sources])
        run([tools / "d8", "--min-api", "28", "--lib", jar, "--output", dex, *sorted(classes.rglob("*.class"))])
        dex_files = sorted(dex.glob("classes*.dex"))
        if not dex_files:
            raise ValueError("D8 produced no dex")
        # 解析真实DEX类表；拒绝覆盖NSH或重复类，不把源文件存在当作DEX已包含。
        def dex_classes(file):
            dump = capture([tools / "dexdump", file])
            return set(re.findall(r"Class descriptor\s*:\s*'([^']+)'", dump))
        additions = set()
        for file in dex_files:
            classes_in_file = dex_classes(file)
            if additions & classes_in_file:
                raise ValueError("Duplicate classes in generated DEX")
            additions |= classes_in_file
        for required in ["RequiredUpdater", "UpdateResultReceiver", "UpdaterInitProvider"]:
            if f"Ltop/maplayer/collaboration/update/{required};" not in additions:
                raise ValueError(f"Generated DEX lacks {required}")
        all_classes = set(additions)
        with zipfile.ZipFile(args.input_apk) as original:
            for name in names:
                if re.fullmatch(r"classes(?:\d+)?\.dex", name):
                    file = work / ("original-" + name)
                    file.write_bytes(original.read(name))
                    original_classes = dex_classes(file)
                    all_classes.update(original_classes)
                    if original_classes & additions:
                        raise ValueError("Generated DEX duplicates an original class")
        verify_manifest_dex(root, all_classes, args.enable_experimental_oauth)
        # META-INF只去除签名项，保留其他元数据。v2/v3签名block不属于ZIP项，会随重封装清除。
        signing = re.compile(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$", re.I)
        dex_numbers = [1 if name == "classes.dex" else int(re.fullmatch(r"classes(\d+)\.dex", name)[1])
                       for name in names if re.fullmatch(r"classes(?:\d+)?\.dex", name)]
        next_dex = max(dex_numbers, default=0) + 1
        unaligned, aligned = work / "unaligned.apk", work / "aligned.apk"
        with zipfile.ZipFile(args.input_apk) as original, zipfile.ZipFile(manifest_apk) as manifest, zipfile.ZipFile(unaligned, "w") as output:
            for info in original.infolist():
                if signing.fullmatch(info.filename):
                    continue
                data = original.read(info.filename)
                if info.filename == "AndroidManifest.xml":
                    data = manifest.read("AndroidManifest.xml")
                elif re.fullmatch(r"lib/[^/]+/libnsh\.so", info.filename):
                    data = libs[info.filename.split("/")[1]].read_bytes()
                output.writestr(info, data)
            for index, file in enumerate(dex_files, next_dex):
                output.writestr(f"classes{index}.dex", file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        run([tools / "zipalign", "-P", "16", "-f", "4", unaligned, aligned])
        password = "pass:android" if args.test_signing else "env:NSH_KEYSTORE_PASSWORD"
        run([tools / "apksigner", "sign", "--ks", args.keystore_existing, "--ks-key-alias", args.key_alias,
             "--ks-pass", password, "--key-pass", password, aligned])
        run([tools / "apksigner", "verify", "--verbose", aligned])
        if args.enable_updater_host or args.enable_collaboration_host:
            original_signers = signer_certificates(capture([tools / "apksigner", "verify", "--print-certs", args.input_apk]))
            final_signers = signer_certificates(capture([tools / "apksigner", "verify", "--print-certs", aligned]))
            if original_signers != final_signers:
                raise ValueError("Standard updater packaging must preserve the base APK signing identity")
        run([tools / "zipalign", "-c", "-P", "16", "4", aligned])
        final_xml = capture([analyzer, "manifest", "print", aligned])
        final_root = ET.fromstring(final_xml)
        if args.enable_updater_host or args.enable_collaboration_host:
            verify_updater_host(final_root, args.enable_experimental_oauth, args.enable_collaboration_host)
        verify_auth_manifest(final_root, args.enable_experimental_oauth)
        verify_manifest_dex(final_root, all_classes, args.enable_experimental_oauth)
        for required in ["UpdaterInitProvider", "UpdateResultReceiver", "REQUEST_INSTALL_PACKAGES"]:
            if required not in final_xml:
                raise ValueError(f"Final manifest missing {required}")
        changed = {"AndroidManifest.xml"} | {f"lib/{abi}/libnsh.so" for abi in libs}
        with zipfile.ZipFile(args.input_apk) as original, zipfile.ZipFile(aligned) as final:
            native_hashes = {}
            for abi, library in libs.items():
                packaged = final.read(f'lib/{abi}/libnsh.so')
                expected = library.read_bytes()
                if packaged != expected:
                    raise ValueError(f'Final native host differs from the verified build: {abi}')
                native_hashes[abi] = hashlib.sha256(packaged).hexdigest()
            for name in names:
                if name in changed or signing.fullmatch(name):
                    continue
                if original.read(name) != final.read(name):
                    raise ValueError(f"Original asset changed: {name}")
        aligned.rename(args.output_apk)
        digest = hashlib.sha256(args.output_apk.read_bytes()).hexdigest()
        report = dict(schema=1, platform='android', apk_filename=args.output_apk.name,
            apk_sha256=digest, apk_size=args.output_apk.stat().st_size,
            requested_host_mode='collaboration' if args.enable_collaboration_host else 'updater' if args.enable_updater_host else 'experimental',
            native_sha256=native_hashes, generated_dex_classes=sorted(additions),
            manifest_components=sorted(child.get(A+'name', '') for child in final_root.find('application')),
            original_resources_preserved=True, signing_identity_preserved=bool(args.enable_updater_host or args.enable_collaboration_host),
            signature_verified=True, zip_alignment='16KiB verified', runtime_validation='not-run', release_eligible=False)
        evidence_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(f"APK built and verified: {args.output_apk}\nSHA256: {digest}\nSigning: {'existing-debug-test-only' if args.test_signing else 'provided-release-key'}\nDevice installation: NOT RUN")


if __name__ == "__main__":
    main()
