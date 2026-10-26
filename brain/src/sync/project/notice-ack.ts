// notice_ack: the one object that may leave before consent (G1). Version id, time, jurisdiction, listed features.
import type { NoticeAck, NoticeAckInput, ProjectionContext } from "../types.ts";

export function projectNoticeAck(i: NoticeAckInput, ctx: ProjectionContext): NoticeAck {
  return {
    id: ctx.ids("notice_ack", i.noticeVersionId, i.acknowledgedAt),
    kind: "notice_ack",
    createdAt: i.acknowledgedAt,
    noticeVersionId: i.noticeVersionId,
    acknowledgedAt: i.acknowledgedAt,
    jurisdiction: i.jurisdiction,
    features: [...new Set(i.features)].sort(),
    channel: "mac_app",
  };
}
