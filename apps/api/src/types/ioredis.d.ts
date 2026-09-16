declare module 'ioredis' {
  export default class Redis {
    public constructor(url: string)
    public set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK' | null>
    public set(key: string, value: string): Promise<'OK' | null>
    public get(key: string): Promise<string | null>
    public mget(...keys: string[]): Promise<(string | null)[]>
    public smembers(key: string): Promise<string[]>
    public eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>
    public incr(key: string): Promise<number>
    public decr(key: string): Promise<number>
    public expire(key: string, seconds: number): Promise<0 | 1>
    public quit(): Promise<'OK'>
  }
}
