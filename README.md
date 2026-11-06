Name: dsh-big-fish-speak

Live: 桌宠音色版（0.7.2）

方法：不再自己合成音频，直接调 dsh-pet 的本地广播接口
  POST http://127.0.0.1:<webServer 端口>/dsh-pet-7340/broadcast?pet=<id>&surface=<desktop|web>
  body {"text": "...", "duration": 毫秒}
桌宠收到后用自己的客户端念：音色取自它设置页的「音色」下拉（默认「晓伊（女·活泼）」/
zh-CN-XiaoyiNeural），音量取「音量」，开关取「语音播报」。同一句话同时显示在气泡里。

命令：
  /speak <文本>       让大肥鱼念这段话（默认念全文）
  /voice              看当前声音、音量、自动播报开关
  /voice test         试听
  /voice auto on|off  开关「模型输出自动播报」

自动播报：监听 session/event 的 assistant/message，模型一有正文就让大肥鱼念，默认念全文。

切句与节奏（0.5.0 的重点）：
  dsh-pet 客户端的单句念白上限是 60 字（VOICE_SPEECH_MAX_CHARS=60），超过会被它自己截断，
  所以必须切。切法是「按标点切」：
    优先断在句末（。！？；…换行），一次送出去的就是一整句话；
    一句话超过 60 字时退到句读（，、：等）；
    实在没有标点才硬切。
  断点太靠前（不到 20 字）不采用，避免切出两三个字的碎句子。
  段与段之间不再用「保守长停顿」，而是按实测语速推进：
    dsh-pet 的 voice-cache 里 mp3 约 6KB/秒（48kbps），反推念白速度 ≈ 0.22 秒/字，
    插件按 0.23 秒/字 + 0.5 秒换气衔接，下限 1 秒。
  上一段还在播的时候，下一段的合成已经在桌宠那边并行跑，所以接得上、不会等你十几秒。

段数上限：不设。
  模型输出多少就念多少，几百上千字都会念完。
  只留一个极端保护 MAX_HARD_CHUNKS=200 段（≈12000 字），正常对话永远碰不到。
  桌宠 /voice/speak 串行队列上限是 3，命中「忙」会退避重试 3 次，不会被静默丢掉。

逐段验收（0.6.0 补的真问题）：
  桌宠的 broadcast 只表示「它收到了」，真正合成失败时它只在 logs.txt 里写一行
      voice speak: failed chars=N voice=edge ms=… reason=Unexpected server response: 429
  而广播接口照样回 ok:true —— 那一段就静默消失，听感就是「念了两句就没了」。
  所以插件现在每送一段都回读 ~/.dsh/dsh-pet/logs.txt：
    多出一行 chars=N 的记录 → 这段真念了；
    那一行是 failed → 退避 3.5 秒 / 7 秒重发，最多 3 次；
    单段最终失败只跳过这一句，后面的句子照念，不会整轮哑掉。
  实测语速 0.23 秒/字，段落之间只按这个节奏扣掉已花掉的合成时间，所以不会空等十几秒。

预热下一段（0.7.0）：
  段间剩下的那点停顿，其实是"下一段还没合成好"。所以上一段刚开始播的时候，
  插件就直接向桌宠的 /voice/speak 预合成下一段（只落缓存、不播放），
  轮到大肥鱼念它时就是 cache=hit，几乎零延迟接上，听感是一句挨一句。

config（cordis.patch.yml 里可空，一般不用填）：
  maxChars     单段字数上限（默认 60，最大 60，只能改小）
  autoChunks   自动播报最多几段（不填 = 不限）
  speakChunks  /speak 最多几段（不填 = 不限）

依赖：dsh-pet（0.4.x）。桌宠不在或没加载完时，命令会明确报「找不到桌宠服务地址」。
不再需要 speak.ps1，也不需要 PowerShell / SAPI / WinRT。

免责与归属：
  非官方插件，与 DeepSeek Harness、dsh-pet（github.com/PC2005-cloud/dsh-pet，MIT）的作者
  均无隶属关系，也未经其背书。本插件只调用 dsh-pet 的本机接口，不含其任何源代码或素材。
  语音合成由 dsh-pet 完成（其使用 Edge TTS 免费接口），本插件不自带语音服务，
  不收集、不上传任何数据；只在本机读取桌宠的 logs.txt 用于确认是否真的出声。
  「大肥鱼」是本插件使用者的桌宠昵称，与任何第三方角色或商标无关。
