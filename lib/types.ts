export type Phase =
  | "input"
  | "loading"
  | "explain"
  | "question"
  | "grading"
  | "respond"
  | "reflect";

export type Verdict = "nailed it" | "on the right track" | "not quite";

export interface Lesson {
  title: string;
  /** A coherent explanation at the chosen technicality. */
  explanation: string;
  /** The question the model poses about the central idea. */
  question: string;
  /** 1-3 short statements a correct answer must convey. */
  keyPoints: string[];
}

export interface Response {
  verdict: Verdict;
  feedback: string;
  /**
   * A slightly adjacent topic to explore next. Used to "continue" the loop
   * into a new branch once the learner gets the answer right.
   */
  nextBranch: string;
}

export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
  sourceTopic: string;
}
