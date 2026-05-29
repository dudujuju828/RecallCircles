export type Phase =
  | "input"
  | "loading"
  | "read"
  | "build"
  | "result"
  | "question"
  | "grading"
  | "feedback"
  | "reflect";

export type Level = "simple" | "standard" | "deep";

export type Verdict = "nailed it" | "on the right track" | "not quite";

export interface Passage {
  title: string;
  chunks: string[];
  question: string;
  keyPoints: string[];
}

export interface Grade {
  verdict: Verdict;
  feedback: string;
}

export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
  sourceTopic: string;
}

/** A piece in the reconstruction pool. */
export interface Piece {
  id: number;
  revealed: boolean;
}
