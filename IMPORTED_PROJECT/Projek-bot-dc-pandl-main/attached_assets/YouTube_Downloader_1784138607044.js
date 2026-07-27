/**
 * YouTube Downloader
 * -----------------------------
 * Type    : Plugins ESM
 * creator : Hilman
 * Channel : https://whatsapp.com/channel/0029VbAYjQgKrWQulDTYcg2K
 * API     : https://kaizenapi.my.id
 */

import fetch from 'node-fetch'
import yts from 'yt-search'

let handler = async (m, { conn, text, command }) => {
  if (!text) throw 'Masukkan judul atau URL YouTube!'

  await m.react('🕒')

  try {
    let url = text
    let info = null

    if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/i.test(text)) {
      let search = await yts(text)

      if (!search.videos.length)
        throw 'Video tidak ditemukan.'

      info = search.videos[0]
      url = info.url
    } else {
      let search = await yts(text)

      if (search?.videos?.length) {
        info = search.videos[0]
      }
    }

    let res = await fetch(
      `https://kaizenapi.my.id/downloader/youtube?url=${encodeURIComponent(url)}`
    )

    let json = await res.json()

    if (!json.status) throw 'Yahh error.'

    let data = json.result

    let caption = `YOUTUBE DOWNLOADER

❀ Judul : ${data.title}
❀ Durasi : ${data.duration}
❀ Upload : ${info?.ago || '-'}
❀ Views : ${info?.views?.toLocaleString('id-ID') || '-'}
❀ Channel : ${info?.author?.name || '-'}
❀ Tipe : ${command.toUpperCase()}`

    await conn.sendMessage(
      m.chat,
      {
        image: { url: data.thumbnail },
        caption
      },
      { quoted: m }
    )

    let fileUrl = /ytmp3/i.test(command)
      ? data.audio_mp3
      : data.video_hd

    let head = await fetch(fileUrl, {
      method: 'HEAD'
    })

    let size = Number(head.headers.get('content-length')) || 0

    if (size > 50 * 1024 * 1024) {
      await conn.sendMessage(
        m.chat,
        {
          document: { url: fileUrl },
          mimetype: /ytmp3/i.test(command)
            ? 'audio/mpeg'
            : 'video/mp4',
          fileName: `${data.title}${/ytmp3/i.test(command) ? '.mp3' : '.mp4'}`
        },
        { quoted: m }
      )
    } else {
      await conn.sendMessage(
        m.chat,
        /ytmp3/i.test(command)
          ? {
              audio: { url: fileUrl },
              mimetype: 'audio/mpeg',
              fileName: `${data.title}.mp3`
            }
          : {
              video: { url: fileUrl },
              mimetype: 'video/mp4',
              fileName: `${data.title}.mp4`
            },
        { quoted: m }
      )
    }

  } catch (e) {
    throw 'Yahh error.'
  }
}

handler.help = ['ytmp3 <judul/url>', 'ytmp4 <judul/url>']
handler.tags = ['downloader']
handler.command = /^(ytmp3|ytmp4)$/i
handler.limit = true

export default handler