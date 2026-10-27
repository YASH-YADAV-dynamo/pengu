import { get } from './models'

// transformers.js for the main process, set up once: models are read from the on-disk cache the downloader fills
// (userData/models) and never fetched from the network here. Shared by the voice and writing assistants.
let t: Promise<typeof import('@huggingface/transformers')> | null = null

export const transformers = () =>
  (t ??= import('@huggingface/transformers').then((m) => {
    m.env.allowLocalModels = false
    m.env.useFSCache = false
    m.env.useBrowserCache = false
    m.env.useCustomCache = true
    m.env.customCache = {
      match: async (req: string | Request) => {
        const data = await get(typeof req === 'string' ? req : req.url)
        return data ? new Response(data as BodyInit) : undefined
      },
      put: async () => {}
    }
    return m
  }))
