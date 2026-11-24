export const commentMaxLength = 10000;
export const commentRequestBytes = 64 * 1024;
export type Rating = "like" | "dislike" | "none";

export interface YouTubeIdentity {
  id: string;
  title: string;
  canWrite: boolean;
}

export type CommentState = "empty" | "posted" | "busy" | "unknown" | "verify";

export interface VideoInteraction {
  channel: YouTubeIdentity;
  rating: Rating | null;
  ratingFresh: boolean;
  comment: CommentState;
}

export interface CommentDetails {
  state: CommentState;
  body?: string;
  revision?: string;
}
