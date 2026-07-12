# Home Cinema V9 开发记录

记录日期：2026-07-12  
开发分支：`chrome-extension`  
功能基线提交：`d026dcb Automate stalled speaker recovery`  
同步引擎：`v9`  
Chrome 插件：`0.3.13`

## 1. 当前产品方向

当前阶段只解决一个明确场景：

1. 一台电脑负责播放视频或音乐，并运行 Chrome 插件采集当前标签页音频。
2. 一个 Home Cinema Node.js 服务负责局域网设备发现、时钟、控制和 WebRTC 信令。
3. 其他 Mac、Windows、iPhone、iPad 或 Android 设备作为 Speaker，只播放收到的音频。
4. 视频仍留在 Controller 电脑上，其他设备不需要寻找并播放同一个视频。
5. 当前优先目标是开始时允许多等待，开始后尽量平滑、持续同步，并在单台设备出错时不影响健康设备。

当前没有改用 UDP。媒体仍使用 WebRTC/Opus，因为浏览器可以直接使用它的低延迟传输、抖动处理、丢包隐藏和拥塞控制。

## 2. 系统组成

| 模块 | 当前职责 |
| --- | --- |
| Chrome 插件 | 使用 `tabCapture` 采集当前标签页，通过 offscreen document 维持采集，并向 Speaker 建立 WebRTC 音频连接 |
| Node.js 服务 | 提供 Controller/Speaker 页面，维护房间状态、WebSocket 控制、时钟测量、WebRTC 信令和设备健康状态 |
| Controller 页面 | 显示房间和每台设备状态，控制音量、静音、测试音、手动重连和同步重试 |
| Speaker 页面 | 接收 WebRTC/Opus，测量真实 RTP 播放延迟，并通过 Web Audio 的 DelayNode 和 GainNode 完成补偿、淡出和淡入 |

一个房间只需要启动一个 Node.js 服务。其他设备通过该服务给出的物理 WLAN 或 Ethernet 地址加入，不需要各自在本地运行 `npm start`。

## 3. 已完成的基础能力

### Chrome 标签页音频

- 插件可以直接采集 YouTube、Bilibili 等当前 Chrome 标签页的音频。
- 原视频继续在 Controller 电脑播放，局域网内其他设备作为扩展音箱。
- WebSocket 负责控制、状态和信令，WebRTC/Opus 负责实时音频。
- 捕获连接短暂重建时尽量保留原标签页音频流。
- DRM 受保护内容仍可能拒绝采集，插件不会绕过 DRM。

### 网络地址

- Windows 优先显示真实 WLAN/Ethernet 地址，不再优先选择 VMware、Hyper-V、WSL、VPN 或 bridge 地址。
- 同一台电脑上的插件服务地址使用 `127.0.0.1`，Speaker 扫码地址使用局域网物理网卡地址。
- 插件保存的 Controller service 不再被当前 Home Cinema 标签页或虚拟网卡地址随意覆盖。
- 远程电脑只需打开服务电脑的 LAN 地址，不需要在每台设备上启动 Node.js。

### Controller 和设备控制

- Controller 身份由显式的 `?mode=controller` 页面确定，远程 LAN 页面默认作为 Speaker。
- Controller 可以控制房间音量和单台设备音量。
- Controller 可以停止、恢复、测试和手动重连单台 Speaker。
- 健康监控分为 Connection、Audio、Sync 三层，并显示每台设备的 Current action 和最近事件。

### iPhone 和 iPad

- Speaker 页面会尝试请求适合长时间播放的浏览器音频会话。
- 修复了部分 iOS 设备使用蓝牙耳机可以播放、使用本机扬声器却没有声音的问题。
- iOS 仍受浏览器用户手势和后台策略限制。AudioContext 进入 `suspended` 后必须在该设备上再次点击，Controller 不能绕过这一安全限制。

## 4. V9 同步算法基线

### 4.1 启动阶段

实时标签页音频采用四阶段启动：

1. `Measuring`：建立媒体路径但保持静音，收集 3 个连续且 RTP 确实前进的延迟样本。
2. `Locking`：验证样本稳定性并计算每台设备的一次性本地补偿。
3. `Armed`：服务器发布未来的共同开始时间。
4. `Playing`：各设备依据服务器时钟偏移，在同一目标时间淡入。

测量窗口的关键参数：

- 样本数量：3。
- 样本最大年龄：8 秒。
- 稳定样本最大 spread：12ms。
- Measuring 和 Locking 各自最多等待 12 秒。
- Locking 最多重试 3 次，锁定容差为 10ms。
- 房间目标延迟限制在 100ms 到 500ms，并增加 8ms 安全余量。

当设备数量小于 3 时，全部可用设备参与初始目标。设备数量达到 3 台以上时，算法使用中位数和稳定多数群组；比中位数慢 45ms 以上的单个离群设备可以暂时排除，避免它提高整个房间的延迟。群组至少需要覆盖三分之二设备。

### 4.2 播放中持续监控

系统不是只发送一次开始 trigger。Speaker 会持续报告 WebRTC、音频输出和时间线状态，服务器持续判断房间及单台设备是否健康。

- 本地监控间隔：250ms。
- 静音隔离期间的修正间隔：500ms。
- 正常可听期间的修正间隔：2 秒。
- 每次延迟修正最大 3ms，并使用 1.8 秒 Web Audio ramp，减少抽动和爆音。
- 同步误差超过 25ms 并连续出现 3 次时，设备进入隔离恢复。
- 单次原始误差达到 80ms 时，Fast Fuse 立即隔离该设备。
- Fast Fuse 淡出为 160ms，普通隔离淡出为 450ms。
- 恢复需要连续 6 次进入 8ms 范围；允许单次不超过 16ms 的噪声样本。
- 重新加入前保留 1.2 秒准备时间，并使用 1.2 秒淡入。

### 4.3 房间共同漂移

如果至少三分之二的设备都出现 40ms 以上的正向漂移，而且本地延迟已经没有足够的减少空间，系统会判断这是房间共同时间线变化，而不是单台 Speaker 故障。

共同漂移持续 6 个样本后，系统提高房间目标并执行一次协调 relock。新目标至少比旧目标增加 12ms，连续 relock 之间有 15 秒冷却时间。V8 的稳定群组规则同样用于 relock，单个慢设备不会决定全房间目标。

### 4.4 V9 自动重连

V9 在静默修正和房间 relock 之后增加了最后一级自动恢复：

1. 单台设备进入持续 `recovering` 后，先给现有算法 8 秒自行恢复。
2. 仍未恢复时，只让该设备柔和淡出并重建 WebSocket/WebRTC 路径。
3. 再次持续失锁时使用 16 秒、32 秒退避。
4. 最多自动尝试 3 次，随后保留静音并提示人工检查。
5. WebRTC transport 直接进入 `failed`、`disconnected` 或 `closed` 时，等待 2 秒后快速重连。
6. 正常设备不会收到重连命令，会继续播放。
7. 静音设备、尚未 Enable 的设备，以及 AudioContext 为 `suspended` 的设备不会被自动强行重连。

Controller 会显示 `Automatic retry 1/3`，Recent events 中也会记录自动重连和尝试耗尽事件。手动 Reconnect 仍作为备用操作保留。

## 5. 版本演进记录

| 提交 | 主要变化 |
| --- | --- |
| `300b8a7` | 平滑 WebRTC 漂移恢复 |
| `b96854d` | Speaker 加入地址优先选择 WLAN |
| `db7ee44` | 同机 Controller service 自动迁移到 loopback |
| `9c29125` | 修复 iOS Speaker 音频路由 |
| `b552515` | 恢复插件服务地址规范化 |
| `c377b58` | V5 三层设备健康监控 |
| `5a5935b` | 修复 Speaker 长时间卡在 recovery |
| `4456443` | 异常设备平滑隔离和重新加入 |
| `0aba39f` | V7 自适应房间 relock 和 Controller 输出延迟跟踪 |
| `48a8768` | V8 稳定多数群组，健康设备继续播放 |
| `d026dcb` | V9 持续异常设备自动重连和退避 |

## 6. 已完成验证

- `npm test`：71 项测试全部通过。
- `npm run build`：Vite 生产构建通过。
- `node --check server.js`：服务端语法检查通过。
- 双 Speaker 集成探针：一台保持健康，一台进入持续 recovering。
- 异常 Speaker 在约 8.4 秒收到第一次自动重连。
- 健康 Speaker 没有收到重连或停止命令。

## 7. 当前启动和升级方式

```bash
npm start
```

然后：

1. 在 `chrome://extensions` 重新加载 `extension/`。
2. 刷新 Controller 和所有 Speaker 页面。
3. 每台 Speaker 点击一次 `Enable speaker`。
4. 确认 `/state` 返回 `requiredSyncEngineVersion: 9`。
5. 从插件重新开始标签页音频。

V9 会拒绝旧同步引擎页面参与锁定，所以服务升级后必须刷新所有 Speaker 页面。

## 8. 仍未完成或无法完全保证的部分

- 还没有实现房间 PIN、Controller 身份令牌和设备批准。
- 当前插件不是一个完全独立的服务器，房间仍需要一台电脑运行 `npm start`。
- 浏览器无法精确知道扬声器、蓝牙耳机和操作系统混音器内部的全部物理延迟。
- Bluetooth 路径变化会造成明显输出延迟变化，切换输出设备后应重新测量或重新加入。
- 软件可以对齐可观测的音频时间线，但不同扬声器距离、房间反射和硬件 DSP 仍会影响听感，不能承诺采样级物理相位一致。
- iOS 在锁屏、后台或系统回收音频会话后可能需要再次点击恢复。
- 目前一次只允许一个实时 Chrome 标签页采集会话。
- 自动重连主要处理 Speaker。Controller 或 Node.js 服务本身退出时，仍需要恢复服务或重新开始采集。

## 9. 下一轮建议测试矩阵

1. Mac Controller + Mac Speaker，连续播放 20 分钟。
2. Windows Controller + Mac Speaker，记录输出延迟变化和 relock 次数。
3. Windows Controller + iPad 本机扬声器，保持前台 20 分钟。
4. Windows Controller + iPad 蓝牙耳机，对比切换前后的 output latency。
5. 2 台 Speaker 和 3 台以上 Speaker 分别测试单台网络恶化。
6. 测试过程中记录每台设备的 Sync error、playout delay、output latency、packet loss、concealment 和自动重连次数。

下一阶段应先采集这些测试数据，再调整 25ms、40ms、45ms 和自动重连等待时间，避免只凭一次听感继续修改阈值。
