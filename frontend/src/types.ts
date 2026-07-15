export interface AppStatus {
  queue: { pending: number; current: { path: string; filename: string; stage: string } | null };
  corpus: { documents: number; chunks: number };
  privacy_mode: string;
  embedding_backend: string;
  ocr_engine: string | null;
  onboarded: boolean;
}

export interface Settings {
  watched_folders: string[];
  llm_provider: "none" | "local" | "anthropic" | "openai";
  llm_model: string;
  ollama_url: string;
  ollama_model: string;
  cloud_ocr_enabled: boolean;
  onboarded: boolean;
  has_anthropic_key: boolean;
  has_openai_key: boolean;
}

export interface DocumentRow {
  id: number;
  path: string;
  filename: string;
  doc_type: string;
  doc_type_source: string;
  page_count: number;
  status: string;
  status_detail: string;
  used_ocr: number;
  added_at: string;
  processed_at: string | null;
}

// page,x0,y0,x1,y1 and (for newly indexed docs) the line's own text
export type BBox = [number, number, number, number, number, string?];

export interface Citation {
  chunk_id: number;
  quoted_span: string;
  document_id: number;
  filename: string;
  page_number: number;
  doc_type: string;
  bboxes: BBox[];
  section_heading: string;
}

export interface RetrievedPassage {
  chunk_id: number;
  text: string;
  filename: string;
  document_id: number;
  page_number: number;
  bboxes: BBox[];
}

export interface FileHint {
  document_id: number;
  filename: string;
  reason: string;
}

export interface AskResponse {
  answer: string | null;
  citations: Citation[];
  sources: { document_id: number; filename: string; doc_type: string }[];
  no_answer: boolean;
  found_in_documents: number;
  provider?: string;
  model?: string;
  llm_error?: string;
  retrieved_passages?: RetrievedPassage[];
  file_hints?: FileHint[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  response?: AskResponse;
}
