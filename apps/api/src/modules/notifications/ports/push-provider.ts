export type PushMessage = {
  token: string
  title: string
  body: string
  data: Record<string, string>
}

export interface PushProvider {
  sendPush(message: PushMessage): Promise<void>
}
