// お知らせの未読の数: 読んだ時刻より新しいもののうち、自分がした操作は数えない(自分で操作するたびに積もらないように)
export const unreadCount = (items: { at: string; mine?: boolean }[], seen: string) => items.filter((e) => !e.mine && e.at > seen).length;
