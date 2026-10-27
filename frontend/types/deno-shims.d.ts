// Minimal Deno globals for type-checking supabase/functions with tsc (see tsconfig.functions.json).
// Only what the functions use; the real runtime is Supabase Edge (Deno).
declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };
