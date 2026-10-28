# 云厂商品牌图标

用途：桌面端云账号管理等界面按 `cloud_type` 显示厂商品牌图形，全部随应用打包，运行时不请求外部图标服务。

- `alibabacloud.svg` / `amazonwebservices.svg` / `baidu.svg` / `googlecloud.svg` / `huawei.svg` / `vultr.svg`：Simple Icons 13 的单色图形，界面内通过 CSS `fill: currentColor` 着色。来源：https://github.com/simple-icons/simple-icons/blob/13/icons/<同名>.svg
- `microsoft.svg`：Microsoft 四色方块标识（用于 Azure），本地已有图形。
- `oracle.svg`：Oracle 红色椭圆标识的本地简化图形。
- `tencentcloud-color.svg` / `volcengine-color.svg`：LobeHub Icons 彩色品牌图形，来源：https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons 。采用 MIT，声明保存在 `lobehub-LICENSE.md`。
- `jdcloud.svg`：京东云官网品牌图形，来源：https://img1.jcloudcs.com/portal/index/v11/footer2/logo.svg 。仅提取红色图形部分并保留原始路径、颜色和比例，不含文字；商标权归京东云所有，不作为通用图标素材授权。来源核验于 2026-10-28。
- 桌面端及手机端共用以上静态资源。天翼云、UCloud、青云、金山云、七牛云暂沿用 catalog 中的文字头像。
- Simple Icons 图形采用 CC0，完整声明保存在 `simple-icons-LICENSE.md`。品牌商标权归各品牌所有。

只用于标识用户条目的云厂商，不表示品牌背书。已检查 SVG 不含脚本、事件或外部资源引用。
