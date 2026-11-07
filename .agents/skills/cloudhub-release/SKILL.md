---
name: cloudhub-release
description: "同步发布 CloudHub Tools 桌面与手机 App，完成版本验证、标签推送、Android 签名上传和发布附件验收。"
---

# CloudHub Release

Use this skill when the user asks to publish, release, or submit a new CloudHub Tools version. Every release includes desktop and mobile App packages from the same main commit and tag, unless the user explicitly narrows the scope. `.github/workflows/release.yml` builds desktop packages; `.github/workflows/mobile-release.yml` builds Android and iOS when a `v*` tag is pushed.

用户说“发布新版本”即授权本次发布需要的版本更新、验证、中文提交、推送 `origin/main` 与版本标签，无需重复询问这些常规发布步骤。默认只发布 Windows x64、macOS Intel 和 Apple Silicon、Android ARM64、iOS 未签名 Xcode 归档；暂不构建 Linux 或其他平台。先推送 main 并确认 origin/main 的提交，再推送指向该提交的版本标签，各平台必须检出同一标签。

## Version Files

Keep the release version identical in all of these files:

- `package.json`
- `package-lock.json` (root package entry)
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` (`cloudhub-tools` package entry)
- `src-tauri/tauri.conf.json`
- `src/App.tsx` (`bundledVersion`)

Unless the user specifies otherwise, increment the patch version. Use the release tag `v<version>` and commit message `发布 v<version> 版本`.

## Workflow

1. Inspect `git status`, the current version, the latest commit, and existing tags. Do not revert or stage unrelated user changes.
2. **Android signing preflight, before any version commit, push, or tag:** confirm the canonical keystore exists at `local-signing/android-release-signing.keystore`, is ignored by Git, and its SHA-256 certificate fingerprint matches the latest published Android APK. The current baseline is v0.1.125, which introduced a replacement certificate after the user explicitly accepted that older APK installs may not update in place. Future releases must keep this new certificate. Confirm the signing alias and that both keystore access and private-key access are available. Merely listing the certificate or matching its fingerprint is not proof that the private key can sign.
   - Obtain the keystore and key-entry passwords from the approved password manager/secret store, or ask the user once to enter them in a masked local prompt. Never ask them to paste a password into chat. Do not guess, try common defaults, search unrelated personal files, or persist the password in task notes, shell history, command arguments, repository files, logs, or automation prompts.
   - Prove private-key access using `keytool -certreq -keystore <canonical-keystore> -alias <release-alias> -file <temporary-csr>` with passwords entered only at its masked interactive prompts. Verify the displayed SHA-256 fingerprint against the latest release, then remove the non-secret temporary CSR. Do not use `keytool -list` alone as the signing-readiness test.
   - This workstation's signing password is stored only in `local-signing/android-release-signing.password.dpapi`, protected with current-user Windows DPAPI. The local helper is `local-signing/sign-android-release.ps1`; use its `Sign` action so the password is decrypted into the current process environment only and cleared afterward. Never print the credential or DPAPI blob. The pre-v0.1.125 keystore is preserved as `local-signing/android-release-signing-legacy-20261107.keystore` and must not be used for new releases.
   - If the current user's DPAPI credential is unavailable or private-key access fails, stop before pushing `main` or a release tag. Explain once that Android signing cannot proceed, and request one action: restore the protected credential from backup or explicitly defer the release. Do not repeat the same request in background follow-ups; mark it blocked pending user action.
3. Update all version files together. Confirm the old version no longer appears in the release metadata.
4. Run `npm run build` from the repository root and `cargo check --target-dir target-codex-check` from `src-tauri`.
5. Stage only the intended source, skill, ignore-rule, and version files. Never stage `src-tauri/target-codex-check/` or other generated build output.
6. Run `git diff --cached --check`, commit on main, and push `main` to `origin`. Verify with `git ls-remote origin refs/heads/main` that the remote commit matches the release commit, then create and push the tag pointing at that commit.
7. 确认桌面及手机发布工作流已启动，记录版本、提交、标签、构建链接及待完成事项，通过 task-tracker 保存跨会话进度。使用可用的自动化工具为当前聊天建立 heartbeat 后台跟进（优先更新同一版本已有跟进，避免重复）；跟进提示须包含构建检查、Android 签名上传及最终附件验收，仅在全部完成、失败或需要用户操作时通知，无变化保持静默。确认后台跟进已建立后立即回复“已启动发布”、版本号及构建链接，结束本轮等待。用户要求发布即包含此后台跟进授权。若当前环境不支持后台跟进，应如实说明限制，不能承诺回复后自动继续。
8. 后台检查桌面及手机发布工作流。Android workflow 当前只保存 unsigned APK artifact：下载同一标签的 artifact，使用预检通过的既有签名证书签名，验证 APK 版本与 ARM64 架构、签名，并核对证书摘要与上一版本一致，再上传到同一 GitHub Release，名称必须为 `CloudHub.Tools_<version>_android_arm64.apk`，供手机更新器识别。若签名工具再次提示缺少/错误密码，不得宣称签名就绪或反复尝试；立即暂停并通知需要用户操作。

   Android 发布签名私钥的唯一规范位置是仓库根目录下 `local-signing/android-release-signing.keystore`（当前工作区绝对路径：`E:\acode\cloudhub-tools\local-signing\android-release-signing.keystore`）。签名前确认文件存在、SHA-256 指纹与上一版一致，且 `git check-ignore` 确认该路径被忽略；缺失或指纹不符时停止并通知用户，不回退到用户目录中的 debug.keystore。只有用户明确授权证书迁移时才可生成替代证书；必须先说明旧安装可能无法原位更新、保留旧私钥备份，并把新密码存入受控本机密钥存储。不得将私钥上传到仓库/GitHub。
8. 验证 Release 附件包含桌面包、签名 Android APK、iOS 未签名 Xcode 归档及桌面更新清单；核对 APK 大小和 SHA256 digest，与本地文件一致。iOS 沿用当前未签名归档约定，不能宣称可直接安装 IPA。
9. 完成 GitHub Release 全部附件验收后，继续执行下方“Gitee Release 镜像”，确认 Gitee Release 与附件可访问后才通知“发布完成”。更新任务并关闭本版本的后台跟进。失败或需要用户操作时通知具体原因及缺失附件，不自动反复重试无变化的阻塞。启动阶段可以报告提交、标签和构建链接，但排队构建或 unsigned artifact 不代表发布完成。

## Gitee Release 镜像

- 每个版本都要把 GitHub Release 的附件同步到 `https://gitee.com/cloudhub-tools/cloudhub-tools` 的同名 Gitee Release；不镜像 Git 分支或提交历史。Gitee Release 必须绑定 tag；若 Gitee 上尚无该 tag，镜像 API 会基于 Gitee 默认分支 `main` 创建 Release tag，因此不得声称 Gitee tag 指向 GitHub 的同一提交。
- `.github/workflows/gitee-release-sync.yml` 在 GitHub Release 发布/编辑以及桌面或手机发布工作流成功完成时自动同步已有附件；它也提供 `workflow_dispatch` 作为最终同步入口。由于 Android APK 仍需在发布工作站签名并人工上传到 GitHub Release，前述自动触发可能早于签名 APK 上传。
- 因此，每次发布必须在签名 Android APK、iOS 归档、桌面包和 updater 清单全部上传至 GitHub Release 后，手动运行 `Sync GitHub Release assets to Gitee` 工作流，输入本次 `v<version>` tag，确保最终完整附件集再次同步。若本地有受控流程可在 Android 上传后安全触发该工作流，也可用它替代手动派发，但不能跳过最终同步。
- GitHub 仓库必须预先配置 Actions repository secret `GITEE_TOKEN`，其 Gitee 个人访问令牌须有目标仓库 Release/附件管理权限。缺失或权限不足时不可报告发布完成；不得要求用户把令牌发到聊天或写入仓库。令牌只通过 Actions Secret 注入同步脚本。
- 最终核对 Gitee 同名 Release 存在，并确认 GitHub Release 的每个附件在 Gitee 上均有同名附件、可下载且大小一致；签名 APK 还要比对 SHA-256。重复同步会替换同名附件；Gitee 上仅存在而 GitHub 不存在的其他附件会保留，不将其误报为 GitHub 镜像内容。

## Guardrails

- Stop and report a conflict if the target tag already exists locally or on `origin`; do not force-move release tags.
- If a build, check, commit, tag, or push fails, stop before the next release mutation and report the failing command's essential error.
- A version release does not authorize unrelated refactors or deployment changes.
- 用户明确要求所有后续版本同步发布 App；不得在只推送标签或桌面发布后提前宣布全部发布完成。
- 签名密码与 GitHub 凭据只通过受控 secret store 或隐藏标准输入传递，不写入日志、任务记录、仓库、automation prompt、shell history 或命令行实参。未经用户明确授权，不得因发布助手无法访问密码而新建/替换 keystore；签名证书与本机数据不提交 Git。
- 仓库 `.gitignore` 必须忽略 `/local-signing/`；本地签名目录 ACL 仅允许当前用户、SYSTEM 和 Administrators 访问。私钥文件不进入任何客户端技能、任务记录或构建产物。
