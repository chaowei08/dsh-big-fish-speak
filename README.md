# dsh-big-fish-speak

让 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 桌宠自动播报模型输出。

## 安装

先装好并保持运行 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（0.4.6+）。

在 DSH 插件页添加插件：`dsh-big-fish-speak`

## 用法

- 自动播报默认开启：模型输出后桌宠自动念
- 顶部栏蓝色喇叭图标：播报时有声波动效
- 命令：
  - `/speak <文本>`：让桌宠念这段话
  - `/voice`：查看当前状态
  - `/voice test`：试听一句

## 已知限制

- 音量、音色在桌宠自己的设置页里改
- 正在播放的音频无法立刻停止（桌宠限制）

## License

MIT
