# 英语学习公有领域素材清单

## 版权说明

本目录下的视频素材均为**严格无版权风险**内容，来源如下：

- **美国联邦政府作品**：VOA、Private Snafu 等由政府机构制作
- **公有领域**：1929年前发表的作品（Charlie Chaplin 短片）
- **历史演讲录音**：公开发表的政治演讲属于公有领域

## 素材列表

### 1. VOA Learning English（已有）
- **文件**：`VOA/10050000-0aff-0242-1863-08da63928e02_480p.mp4`
- **类型**：慢速新闻
- **难度**：初级
- **版权**：美国联邦政府公有领域

### 2. Martin Luther King Jr. "I Have a Dream" (1963)
- **文件**：`MLK_I_Have_a_Dream_1963.mp4`（需下载）
- **类型**：历史演讲
- **难度**：中级
- **时长**：约17分钟
- **版权**：公有领域
- **YouTube**：https://www.youtube.com/watch?v=vP4iY1TtS3s
- **Archive**：https://archive.org/details/MLKDream
- **特点**：历史上最著名的演讲之一，节奏感强

### 3. Charlie Chaplin "The Adventurer" (1917)
- **文件**：`Chaplin_The_Adventurer_1917.mp4`（需下载）
- **类型**：默片喜剧
- **难度**：初级
- **时长**：约20分钟
- **版权**：公有领域（1929年前作品）
- **YouTube**：https://www.youtube.com/watch?v=T8pVDQ2c6w8
- **Archive**：https://archive.org/details/CC_1917_The_Adventurer
- **特点**：大众熟悉的文化符号，配乐完整

### 4. Private Snafu - WWII Educational Cartoons
- **文件**：`Private_Snafu_Cartoon.mp4`（需下载）
- **类型**：教育动画
- **难度**：中级
- **时长**：单集约3-5分钟
- **版权**：美国联邦政府公有领域
- **YouTube**：https://www.youtube.com/watch?v=3jZy-BZUIcw
- **Archive**：https://archive.org/details/private_snafu
- **特点**：幽默军事教育短片，历史趣味

### 5. JFK Inaugural Address "Ask Not" (1961)
- **文件**：`JFK_Inaugural_Address_1961.mp4`（需下载）
- **类型**：总统就职演讲
- **难度**：高级
- **时长**：约14分钟
- **版权**：公有领域
- **YouTube**：https://www.youtube.com/watch?v=NwM6s55no6U
- **Archive**：https://archive.org/details/JFKInaugural
- **特点**：历史名场面，"Ask not what your country can do for you"

## 下载方法

### 方法一：自动脚本（推荐）
双击运行目录下的 `download_materials.bat`，脚本会自动下载所有缺失的素材。

**前提条件**：
1. 安装 yt-dlp：`pip install yt-dlp` 或下载 [yt-dlp.exe](https://github.com/yt-dlp/yt-dlp/releases)
2. 确保网络可以访问 YouTube 或 Internet Archive

### 方法二：手动下载

如果脚本下载失败，可以手动访问上述 YouTube 或 Internet Archive 链接下载。

**Internet Archive 直接下载步骤**：
1. 访问上述 archive.org 链接
2. 点击右侧 "Download Options"
3. 选择 MP4 格式下载

**YouTube 下载步骤**：
1. 访问 YouTube 链接
2. 使用浏览器插件（如 Video DownloadHelper）
3. 或使用在线工具（注意：仅用于下载公有领域内容）

### 方法三：前端嵌入（不下载）

如果项目支持在线播放，可以直接嵌入 YouTube 播放器，无需下载文件。

```html
<iframe src="https://www.youtube.com/embed/vP4iY1TtS3s" 
        frameborder="0" allowfullscreen></iframe>
```

## 前端集成

素材清单文件 `materials.json` 可直接被前端读取，用于展示推荐素材列表。

示例用法：
```javascript
fetch('/案例/materials.json')
  .then(r => r.json())
  .then(data => {
    const materials = data.materials;
    // 按难度、类型筛选展示
  });
```

## 更多公有领域素材推荐

如需更多素材，可访问：
- **Internet Archive Moving Image Archive**：https://archive.org/details/movies
- **PublicDomainMovies.info**：http://publicdomainmovies.info/
- **RetroFlix**：https://retroflix.org/
- **LibriVox**（有声书）：https://librivox.org/

## 使用建议

1. **初级学习者**：从 VOA + Charlie Chaplin 开始
2. **中级学习者**：添加 MLK 演讲 + Private Snafu
3. **高级学习者**：挑战 JFK 就职演讲

## 法律声明

本清单及素材仅供教育和学习用途。所有标注为公有领域的素材在美国法律下属于公共财产，可自由使用、修改和分发。

对于其他地区的使用者，请遵守当地版权法律法规。
