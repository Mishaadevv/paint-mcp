declare module "jpeg-js" {
  export interface DecoderOptions {
    useTArray?: boolean;
    tolerantDecoding?: boolean;
    maxResolutionInMP?: number;
    maxMemoryUsageInMB?: number;
  }
  export interface DecodedImage {
    width: number;
    height: number;
    data: Uint8Array | Buffer;
  }
  export interface RawImageData {
    data: Uint8Array | Uint8ClampedArray | Buffer;
    width: number;
    height: number;
  }
  export interface EncodedImage {
    data: Buffer;
    width: number;
    height: number;
  }
  export function decode(buffer: Buffer, options?: DecoderOptions): DecodedImage;
  export function encode(image: RawImageData, quality?: number): EncodedImage;
  const api: { decode: typeof decode; encode: typeof encode };
  export default api;
}
