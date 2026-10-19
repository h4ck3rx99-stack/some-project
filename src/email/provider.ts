export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  name: string;
  send(msg: EmailMessage): Promise<{ ok: boolean; error?: string }>;
}
