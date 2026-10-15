# 微信账号配置与独立会话方案

## 当前交付：账号配置快照

2026-10-15 用户选择按 MultiWeChatManager Python 分支的配置快照方式修改并自行实测。现已加入账号命名保存、加密快照、恢复前备份、逐个恢复启动与备份恢复；支持的文件及操作步骤见 `docs/wechat-official-plugin.md`。

本次只实现该配置切换方式，不安装隔离引擎。它不能等同于下方候选方案的完整文件系统/注册表隔离。没有执行本机真实账号配置读取、写回或登录测试；两个账号头像、认证保持及同时登录效果由用户验证。

以下保留此前候选方案及调研记录。

## 目标与现状

用户需要固定实例分别保存登录状态和聊天数据，重启后仍进入对应实例。
当前实现仅重复启动同一微信程序，未提供实例级文件或注册表隔离；两个窗口显示相同的已记住账号。
此前的真实启动测试只验证两个窗口，不构成独立账号持久化的验收。

## 建议实现

- 在 CloudHub 中建立固定实例，例如“工作微信”“个人微信”。实例使用持久化随机标识，不使用微信号或昵称作目录名。
- 每个实例对应一个独立、固定的 Sandboxie 沙盒。后续启动同一实例始终使用同一沙盒。
- 关闭自动删除与自动恢复清理，确保退出应用、退出 CloudHub 后保留沙盒内容。
- 对微信配置和数据目录配置仅沙盒内可见的读写规则，避免首次启动读取宿主机的已登录账号。需核对当前微信版本实际目录，包括用户自定义存储路径；不能仅凭默认目录宣称隔离完成。
- 登录凭据与聊天数据库由沙盒中的微信管理；CloudHub 仅保存实例名称、随机标识和隔离引擎配置，不导入、解密或复制现有微信数据。
- 界面支持创建实例、单独启动、显示对应的本地存储位置。首版不提供删除实例数据功能，避免误清理聊天记录。
- 首次在各自实例内由用户扫码登录；是否可快捷或自动登录取决于微信本身，不承诺绕过认证。
- 隔离引擎不可用或配置验证失败时拒绝隔离启动，不回退到当前非隔离的批量启动。

## 执行层

- React：在现有微信设置通用弹层提供实例列表与单独启动操作，结果沿用右上角通知。
- Rust/Tauri：固定实例标识与元数据、引擎检测、沙盒配置检查和受限的原生命令调用。禁止由前端传入任意沙盒参数或任意程序路径。
- 本地持久化：只存非敏感实例元数据；沙盒中的微信数据不进入 CloudHub 导出或同步流程。
- 浏览器预览：显示不支持本机隔离运行，不暴露沙盒配置和微信数据。

## 前置条件与当前限制

2026-10-15 检查常见安装路径、Sandboxie 服务和注册表安装位置，未检测到可用引擎。
需用户接受额外安装 Sandboxie-Plus；安装涉及 Windows 服务和驱动，不能由代码修改隐式代替该决定。
当前尚未安装、未创建沙盒、未修改微信数据，也未验证本机微信与隔离引擎的兼容性。

## 验收

1. 用不含微信数据的探针确认两个沙盒的文件、注册表读写互不影响，且关闭后内容仍存在。
2. 关闭宿主微信，分别打开两个沙盒中的微信；确认不会直接继承宿主的已记住账号。
3. 用户在两个实例分别登录不同账号，正常退出后重新启动，核对各自显示的账号与聊天数据。
4. 重启 Windows 后重复第 3 步；必要的微信认证由用户完成。
5. 验证引擎缺失、权限不足、配置失败和重复点击不会回退到共享环境或清理数据。
6. 完成 UI 构建、Rust 编译检查以及上述真实环境验证，才标记独立会话功能完成。

## 官方资料

- https://sandboxie-plus.github.io/sandboxie-docs/Content/StartCommandLine/
- https://sandboxie-plus.github.io/sandboxie-docs/Content/SbieIniCommandLine/
- https://sandboxie-plus.github.io/sandboxie-docs/Content/WriteFilePath.html
- https://sandboxie-plus.github.io/sandboxie-docs/Content/AutoDelete.html

## 2026-10-15：补充网上源码调研

尚未选定实现方案，前述 Sandboxie 路径是候选方案，不是唯一方案。

### 候选：按账号保存并恢复登录配置

参考 `wfql1024/MultiWeChatManager` 的 `python` 分支，而非当前 main 分支。

- `func_core/acc_func_core.py` 的 `operate_acc_config` 实际备份、恢复配置文件；`_open_acc_return_hwnd_and_pid` 在启动前先应用对应账号配置。
- `scripts/original_remote_sw_v9.json` 为微信 4.x 列出 `all_users/config/global_config` 和 `global_config.crc`。
- 逐个恢复配置并等待对应登录窗口就绪，与当前并发启动同一配置不同。
- 这是恢复指定登录账号，不是文件系统或注册表完全隔离。不能据此承诺全部数据已分别隔离。
- 项目还有关闭文件/互斥句柄、修改 DLL、数据库解密等其他功能；本次只读查看公开源码，未运行、未导入到 CloudHub，也未接触本机登录配置内容。
- 若进一步验证此方案，需先明确授权范围并做好可恢复备份；不照搬原项目先删除原配置再复制的流程。源文件和恢复快照都按敏感登录数据保护。
- 尚未验证本机微信 4.1.15.13 的配置恢复、登录授权及进程写回行为。

来源：
- https://github.com/wfql1024/MultiWeChatManager/blob/python/func_core/acc_func_core.py
- https://github.com/wfql1024/MultiWeChatManager/blob/python/scripts/original_remote_sw_v9.json

### 候选：修改克隆程序中的配置标识

同一项目的 `utils/better_wx/coexist.py` 对克隆 EXE/DLL 的配置文件名、自动登录相关文件名及互斥标识执行修改。
这解释了一类“免沙盒共存版”的实现方式，但版本耦合明显，不能当作稳定的官方启动参数。
尚未运行或验证，不建议在未经单独评估时纳入 CloudHub。

来源：https://github.com/wfql1024/MultiWeChatManager/blob/python/utils/better_wx/coexist.py

### 候选：Windows Sandbox 映射宿主持久化目录

`empty-233/tencent-sandbox` 提供实际 `.wsb` 配置，将微信数据目录映射到宿主目录；README 声称微信账号数据可保留。
微软文档也明确可写映射目录的更改在沙盒销毁后保留。因此“Windows Sandbox 无法持久化数据”过于绝对；准确说法是默认内部状态会丢失，而映射目录可以保留。
不过账号授权是否仍有效、注册表和设备标识是否影响登录，以及多个独立实例同时运行的限制仍需针对实际环境验证。

来源：
- https://github.com/empty-233/tencent-sandbox/blob/main/Tencent.wsb
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file

### 调研后的优先级

若用户优先需要恢复不同头像及登录账号，先研究按账号保存登录配置的最小验证；若要求文件和注册表完整隔离，仍优先评估独立持久化沙盒。
当前仅完成公开源码调研，未做本机账号数据写入或真实账号恢复测试。
