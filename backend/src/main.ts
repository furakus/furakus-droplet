import * as Cluster from 'cluster'
import * as Http from 'http'
import * as Express from 'express'
import * as Morgan from 'morgan'
import * as BodyParser from 'body-parser'
import * as Url from 'url'
import * as Redis from 'redis'
import * as Dotenv from 'dotenv'
import * as Useragent from 'express-useragent'
import Axios from 'axios'
import * as PathToRegexp from 'path-to-regexp'
import { promisify } from 'util'
import { ErrorMessage, CreateRequest, CreateResponse } from '../inc/interface'
import IdGenerator from './idgen'

Dotenv.config()

const ID_FORMAT = '\\w{4,}'
const REGEX_ROUTE_CREATE = `/api/create`
// const REGEX_ROUTE_POLLEVENT = `/api/id/:id(${ID_FORMAT})/poll`
const REGEX_ROUTE_DIRECT_DOWNLOAD = `/:id(${ID_FORMAT})/:filename?`
const REGEX_ROUTE_DIRECT_UPLOAD = PathToRegexp(`/:id(${ID_FORMAT})/:filename?`)
const REGEX_BOT_WHITELIST = new RegExp('(curl|wget)')

interface Config {
    listen_host: string
    listen_port: number
    db_host: string
    db_port: number
    storage_server: string
    num_worker: number
}

function load_config(): Config {
    let listen_host = <string | undefined>process.env['LISTEN_HOST']
    let listen_port = <number | undefined>process.env['LISTEN_PORT']
    let db_host = <string | undefined>process.env['DB_HOST']
    let db_port = <string | undefined>process.env['DB_PORT']
    let storage_server = <string | undefined>process.env['STORAGE_SERVER']
    let num_worker = <string | undefined>process.env['NUM_WORKER']
    if (
        listen_host === undefined || listen_port === undefined ||
        db_host === undefined || db_port === undefined ||
        storage_server === undefined || num_worker === undefined
    ) {
        console.error('Invalid dotenv configuration.')
        return process.exit(1)
    } else {
        return {
            listen_host,
            listen_port,
            db_host,
            db_port: parseInt(db_port),
            storage_server,
            num_worker: parseInt(num_worker)
        }
    }
}

interface AsyncRedisClient {
    hsetnxAsync(...args: any[]): Promise<number>
    hgetAsync(...args: any[]): Promise<string>
    hmsetAsync(...args: any[]): Promise<string>
    hmgetAsync(...args: any[]): Promise<any[]>
    expireAsync(...args: any[]): Promise<number>
    renameAsync(...args: any[]): Promise<"OK">
    delAsync(...args: any[]): Promise<number>
    publishAsync(...args: any[]): Promise<number>
    subscribeAsync(...args: any[]): Promise<string>
}

const config = load_config()
const idgen = new IdGenerator()
const client = Redis.createClient(config.db_port, config.db_host)
const db: AsyncRedisClient = {
    hsetnxAsync: promisify(client.hsetnx).bind(client),
    hgetAsync: promisify(client.hget).bind(client),
    hmsetAsync: promisify(client.hmset).bind(client),
    hmgetAsync: promisify(client.hmget).bind(client),
    expireAsync: promisify(client.expire).bind(client),
    renameAsync: promisify(client.rename).bind(client),
    delAsync: promisify(client.del).bind(client),
    publishAsync: promisify(client.publish).bind(client),
    subscribeAsync: promisify(client.subscribe).bind(client)
}
const app = Express()
app.use(Morgan('combined'))
app.use(BodyParser.json())
app.use(Useragent.express())

interface UploadBody {
    size?: number
}

interface PollBody {
    token: string
}

interface NewResponse {
    id: string
    token: string
}

class Session {
    private constructor(
        public id: string,
        public size: number,
        public storage_server: string,
        public flow_id: string,
        public flow_token: string) {}

    static async new(id: string, size: number): Promise<Session | 'EDUP' | 'EOTH'> {
        try {
            let storage_server = config.storage_server
            if (await db.hsetnxAsync(`SESSION@${id}`, 'storage_server', storage_server) !== 1) {
                return 'EDUP'
            }
            let res = await Axios.post(`${storage_server}/new`, JSON.stringify({ size, preserve_mode: true }))
            if (res.status !== 200) {
                return 'EOTH'
            }
            let data: NewResponse = res.data
            if (await db.hmsetAsync(`SESSION@${id}`, {
                size: size,
                flow_id: data.id,
                flow_token: data.token
            }) !== 'OK') {
                return 'EOTH'
            }
            if (await db.expireAsync(`SESSION@${id}`, 300) !== 1) {
                return 'EOTH'
            }
            return new Session(id, size, storage_server, data.id, data.token)
        } catch {
            return 'EOTH'
        }
    }

    static async get(id: string): Promise<Session | null> {
        try {
            await db.renameAsync(`SESSION@${id}`, `SESSION_SZIED@${id}`)
            let data = await db.hmgetAsync(`SESSION_SZIED@${id}`, ['size', 'storage_server', 'flow_id', 'flow_token'])
            await db.delAsync(`SESSION_SZIED@${id}`)
            let size: number | null = data[0]
            let storage_server: string | null = data[1]
            let flow_id: string | null = data[2]
            let flow_token: string | null = data[3]
            if (size === null || storage_server === null || flow_id === null || flow_token === null) {
                return null
            }
            return new Session(id, size, storage_server, flow_id, flow_token)
        } catch {
            return null
        }
    }
}

function validate_id(id: string): boolean {
    if (id.length < 4 || id.length > 64) {
        return false
    }
    return true
}

async function create_session(id: string, size: number): Promise<Session | [number, ErrorMessage]> {
    if (validate_id(id) === false) {
        return [400, ErrorMessage.INVALID_ID]
    }
    if (size <= 0) {
        return [400, ErrorMessage.INVALID_PARAM]
    }
    let session = await Session.new(id, size)
    if (session === 'EOTH') {
        return [500, ErrorMessage.INTERNAL]
    } else if (session === 'EDUP') {
        return [400, ErrorMessage.DUPLICATED_ID]
    }
    return session
}

async function route_direct_upload(req: Http.IncomingMessage, res: Http.ServerResponse): Promise<boolean> {
    if ((req.method !== 'POST' && req.method !== 'PUT') || req.url === undefined) {
        return false
    }
    let req_path = Url.parse(req.url).pathname
    if (req_path === undefined) {
        return false
    }
    let matches = REGEX_ROUTE_DIRECT_UPLOAD.exec(req_path)
    if (matches === null) {
        return false
    }
    // Routing matched
    let content_length = req.headers['content-length']
    if (typeof content_length !== 'string') {
        res.statusCode = 400
        res.end(ErrorMessage.INVALID_PARAM)
        return true;
    }
    let session = await create_session(matches[1], parseInt(content_length))
    if (!(session instanceof Session)) {
        let [code, message] = session
        res.statusCode = code
        res.end(message)
        return true
    }
    res.writeHead(307, { location: `${session.storage_server}/flow/${session.flow_id}/push?token=${session.flow_token}` })
    res.end()
    return true
}

app.post(REGEX_ROUTE_CREATE, async (req: any, res: any) => {
    let create_param: CreateRequest = req.body
    if (create_param.file_size === undefined) {
        res.status(400).json({ msg: ErrorMessage.INVALID_PARAM })
        return
    }
    let id: string = ''
    let session: Session | [number, ErrorMessage] = [500, ErrorMessage.INTERNAL]
    for (let len = 6; len <= 8; len++) {
        id = await idgen.gen(len)
        session = await create_session(id, create_param.file_size)
        if (session instanceof Session) {
            break
        } else {
            let [code, message] = session
            if (message !== ErrorMessage.DUPLICATED_ID) {
                break
            }
        }
    }
    if (!(session instanceof Session)) {
        let [code, message] = session
        res.status(code).json({ msg: message })
        return
    }
    let data: CreateResponse = {
        id,
        flow_storage: session.storage_server,
        flow_id: session.flow_id,
        flow_token: session.flow_token,
    }
    res.json(data)
})

/*
app.post(REGEX_ROUTE_POLLEVENT, async (req: any, res: any) => {
    let id: string = req.params['id']
    let poll_param: PollBody = req.body
    if (validate_id(id) === false) {
        res.status(404).send()
        return
    }
    let sub_db = BlueBird.promisifyAll(Redis.createClient(config.db_port, config.db_host)) as AsyncRedisClient
    try {
        let get_promise = new Promise<string>((resolve, reject) => {
            sub_db.on(`message`, (channel: string, msg: string) => {
                if (msg === 'GET') {
                    resolve()
                }
            })
        })
        await sub_db.subscribeAsync(`NOTIFY@${id}/${poll_param.token}`)
        let flow_token = await db.hgetAsync(`SESSION@${id}`, 'flow_token')
        if (flow_token !== poll_param.token) {
            res.status(404).send()
            return
        }
        await get_promise
        res.json([{ event: 'GET' }])
    } catch {
        res.status(404).send()
        return
    } finally {
        sub_db.quit()
    }
})
*/

app.get(REGEX_ROUTE_DIRECT_DOWNLOAD, async (req:any, res: any) => {
    let ua = req.useragent
    if (ua !== undefined) {
        if (ua.isBot && REGEX_BOT_WHITELIST.exec(ua.source.toLowerCase()) === null) {
            res.status(418).send()
            return
        }
    }
    let id: string = req.params['id']
    let filename: string | undefined = req.params['filename']
    if (validate_id(id) === false) {
        res.status(404).send()
        return
    }
    let session = await Session.get(id)
    if (session === null) {
        res.status(404).send()
        return
    }
    await db.publishAsync(`NOTIFY@${session.id}/${session.flow_token}`, `GET`)
    if (filename === undefined) {
        filename = id
    }
    res.redirect(`${session.storage_server}/flow/${session.flow_id}/pull?filename=${filename}`)
})

let server = Http.createServer()
server.on('checkContinue', async (req: any, res: any) => {
    if (await route_direct_upload(req, res) === false) {
        (<Http.ServerResponse>res).writeContinue()
        app(req, res)
    }
})
server.on('request', async (req: any, res: any) => {
    if (await route_direct_upload(req, res) === false) {
        app(req, res)
    }
})
if (Cluster.isMaster) {
    for (let i = 0; i < config.num_worker; i++) {
        Cluster.fork()
    }
    console.log(`Droplet listening on ${config.listen_host}:${config.listen_port}`)
} else {
    server.listen(config.listen_port, config.listen_host)
}
