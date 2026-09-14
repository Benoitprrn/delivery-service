declare module 'ioredis' {
  export default class Redis {
    public constructor(url: string)
    public set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK' | null>
    public get(key: string): Promise<string | null>
    public expire(key: string, seconds: number): Promise<0 | 1>
    public quit(): Promise<'OK'>
  }
}
