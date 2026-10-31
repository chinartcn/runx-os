-- RunX Store · 迁移 0002
--
-- 加 source_subdir：应用在包内的相对路径。
--
-- 为什么需要它：商店里绝大多数应用来自 GitHub 仓库，下载到的是**仓库归档**，
-- 顶层是仓库名（runx-os-main/），应用在 apps/demo/ 里。内核解包后需要知道
-- 去哪儿找 appex.json，否则每个 GitHub 源的应用都会报「缺少 appex.json」。
--
-- 空字符串 = 不指定，由内核自动探测（包里只有一个 appex.json 时能猜中）。
-- 包里有多个应用时，开发者必须在 meta.json 里写明，否则装不上（也不该乱装）。

ALTER TABLE apps ADD COLUMN source_subdir TEXT NOT NULL DEFAULT '';
