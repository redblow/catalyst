import { createHash } from 'crypto'
import path from 'path'
import { pipeline, Readable } from 'stream'
import { promisify } from 'util'
import { ContentRange } from '../../controller/Controller'
import { AppComponents } from '../../types'
import { compressContentFile } from './compression'
import { ContentEncoding, ContentItem, ContentStorage, SimpleContentItem } from './contentStorage'
const pipe = promisify(pipeline)

export async function createFileSystemContentStorage(
  components: Pick<AppComponents, 'fs'>,
  root: string
): Promise<ContentStorage> {
  // remove path separators / \ from the end of the folder
  while (root.endsWith(path.sep)) {
    root = root.slice(0, -1)
  }
  await components.fs.ensureDirectoryExists(root)

  const getFilePath = async (id: string): Promise<string> => {
    // We are sharding the files using the first 4 digits of its sha1 hash, because it generates collisions
    // for the file system to handle millions of files in the same directory.
    // This way, asuming that sha1 hash distribution is ~uniform we are reducing by 16^4 the max amount of files in a directory.
    const directoryPath = path.join(root, createHash('sha1').update(id).digest('hex').substring(0, 4))
    if (!(await components.fs.existPath(directoryPath))) {
      await components.fs.mkdir(directoryPath, { recursive: true })
    }
    return path.join(directoryPath, id)
  }

  const retrieveWithEncoding = async (
    id: string,
    encoding: ContentEncoding | null,
    range?: ContentRange
  ): Promise<ContentItem | undefined> => {
    const extension = encoding ? '.' + encoding : ''
    const filePath = (await getFilePath(id)) + extension

    if (await components.fs.existPath(filePath)) {
      const stat = await components.fs.stat(filePath)

      // Check if a file range is requested. Encoding is not supported
      if (range && stat.size && !encoding) {
        // Set default values for ranges when they are not defined
        const rangeStart = range.start ?? 0
        const rangeEnd = range.end ?? stat.size - 1

        // Validate ranges
        const isRangeStartValid = rangeStart >= 0 && rangeStart <= stat.size - 1
        const isRangeEndValid = rangeEnd >= 0 && rangeEnd <= stat.size - 1
        const isValidRange = isRangeStartValid && isRangeEndValid && rangeStart <= rangeEnd

        // Return the file only when the range is valid. Otherwise, return the whole file
        if (isValidRange) {
          const ranges = { start: rangeStart, end: rangeEnd }
          return new SimpleContentItem(
            async () => components.fs.createReadStream(filePath, ranges),
            stat.size,
            encoding,
            ranges
          )
        }
      }

      // Return the whole file
      return new SimpleContentItem(async () => components.fs.createReadStream(filePath), stat.size, encoding)
    }
  }

  const noFailUnlink = async (path: string) => {
    try {
      await components.fs.unlink(path)
    } catch (error) {
      // Ignore these errors
    }
  }

  const storeStream = async (id: string, stream: Readable): Promise<void> => {
    await pipe(stream, components.fs.createWriteStream(await getFilePath(id)))
  }

  const retrieve = async (id: string, range?: ContentRange): Promise<ContentItem | undefined> => {
    try {
      return (await retrieveWithEncoding(id, 'gzip', range)) || (await retrieveWithEncoding(id, null, range))
    } catch (error) {
      console.error(error)
    }
    return undefined
  }

  return {
    storeStream,
    retrieve,
    async storeStreamAndCompress(id: string, stream: Readable): Promise<void> {
      await storeStream(id, stream)
      if (await compressContentFile(await getFilePath(id))) {
        // try to remove original file if present
        const compressed = await retrieve(id)
        if (compressed) {
          const raw = await compressed.asRawStream()
          if (raw.encoding) {
            await noFailUnlink(await getFilePath(id))
          }
        }
      }
    },
    async delete(ids: string[]): Promise<void> {
      for (const id of ids) {
        await noFailUnlink(await getFilePath(id))
        await noFailUnlink((await getFilePath(id)) + '.gzip')
      }
    },
    async exist(id: string): Promise<boolean> {
      return !!(await retrieve(id))
    },
    async existMultiple(ids: string[]): Promise<Map<string, boolean>> {
      const checks = await Promise.all(ids.map<Promise<[string, boolean]>>(async (id) => [id, !!(await retrieve(id))]))
      return new Map(checks)
    }
  }
}
