import { BrownEventEmitter } from './event'
import { remoteSshConnect, remoteSshExecStream, remoteSshDisconnect } from '../../../ssh/agentHandle'
import { handleJumpServerConnection, jumpserverShellStreams, jumpserverMarkedCommands } from './jumpserverHandle'

export interface RemoteTerminalProcessEvents extends Record<string, any[]> {
  line: [line: string]
  continue: []
  completed: []
  error: [error: Error]
  no_shell_integration: []
}

export interface ConnectionInfo {
  id?: string
  host?: string
  port?: number
  username?: string
  /**
   * Password for authentication. If both password and privateKey are provided,
   * privateKey takes precedence over password.
   */
  password?: string
  /**
   * Private key for authentication. Takes precedence over password if both are provided.
   */
  privateKey?: string
  passphrase?: string
  asset_ip?: string
  targetIp?: string
  sshType?: string
}

export interface RemoteTerminalInfo {
  id: number
  sessionId: string
  busy: boolean
  lastCommand: string
  connectionInfo: ConnectionInfo
  terminal: {
    show: () => void
  }
}

// Remote terminal process class, using custom event emitter
export class RemoteTerminalProcess extends BrownEventEmitter<RemoteTerminalProcessEvents> {
  private isListening: boolean = true
  private fullOutput: string = ''
  private lastRetrievedIndex: number = 0
  isHot: boolean = false

  constructor() {
    super()
  }

  async run(sessionId: string, command: string, cwd?: string, sshType?: string): Promise<void> {
    try {
      if (sshType === 'jumpserver') {
        await this.runJumpServerCommand(sessionId, command, cwd)
      } else if (sshType === 'ssh') {
        await this.runSshCommand(sessionId, command, cwd)
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private async runSshCommand(sessionId: string, command: string, cwd?: string): Promise<void> {
    const cleanCwd = cwd ? cwd.replace(/\x1B\[[^m]*m/g, '').replace(/\x1B\[[?][0-9]*[hl]/g, '') : undefined
    const commandToExecute = cleanCwd ? `cd ${cleanCwd} && ${command}` : command

    let lineBuffer = ''

    const execResult = await remoteSshExecStream(sessionId, commandToExecute, (chunk: string) => {
      this.fullOutput += chunk

      if (!this.isListening) return

      let data = lineBuffer + chunk
      const lines = data.split(/\r?\n/)
      lineBuffer = lines.pop() || ''

      for (const line of lines) {
        if (line.trim()) this.emit('line', line)
      }
      this.lastRetrievedIndex = this.fullOutput.length
    })

    if (lineBuffer && this.isListening) {
      this.emit('line', lineBuffer)
    }

    if (execResult && execResult.success) {
      this.emit('completed')
    } else {
      const error = new Error(execResult?.error || '远程命令执行失败')
      this.emit('error', error)
      throw error
    }
    // 触发 continue，以便外部 promise 解析
    this.emit('continue')
  }

  private async runJumpServerCommand(sessionId: string, command: string, cwd?: string): Promise<void> {
    const stream = jumpserverShellStreams.get(sessionId)
    if (!stream) {
      throw new Error('未找到 JumpServer 连接')
    }

    // 改进的路径清理：移除所有ANSI序列、终端提示符和特殊字符
    let cleanCwd: string | undefined = undefined
    if (cwd) {
      cleanCwd = cwd
        // 移除ANSI转义序列
        .replace(/\x1B\[[0-9;]*[JKmsu]/g, '')
        .replace(/\x1B\[[?][0-9]*[hl]/g, '')
        .replace(/\x1B\[K/g, '')
        .replace(/\x1B\[[0-9]+[ABCD]/g, '')
        // 移除终端提示符模式 (如: [user@host dir]$ 或 user@host:dir$)
        .replace(/\[[^\]]*\]\$.*$/g, '')
        .replace(/[^@]*@[^:]*:[^$]*\$.*$/g, '')
        .replace(/.*\$.*$/g, '')
        // 移除回车换行和其他控制字符
        .replace(/[\r\n\x00-\x1F\x7F]/g, '')
        .trim()

      // 验证路径是否有效（应该是绝对路径或相对路径）
      if (cleanCwd && !cleanCwd.match(/^[\/~]|^[a-zA-Z0-9_\-\.\/]+$/)) {
        console.log(`[JumpServer ${sessionId}] 无效的工作目录路径，忽略: "${cleanCwd}"`)
        cleanCwd = undefined
      }

      if (cwd && cleanCwd) {
        console.log(`[JumpServer ${sessionId}] 原始路径: "${cwd}" -> 清理后: "${cleanCwd}"`)
      } else if (cwd && !cleanCwd) {
        console.log(`[JumpServer ${sessionId}] 路径清理失败，原始: "${cwd}"`)
      }
    }

    // 对于 JumpServer，使用不同的命令构造方式
    const commandToExecute = cleanCwd ? `cd "${cleanCwd}" && ${command}` : command

    // 创建唯一的命令标记，使用更独特的格式
    const timestamp = Date.now()
    const randomId = Math.random().toString(36).substring(2, 14)
    const startMarker = `===CHATERM_START_${timestamp}_${randomId}===`
    const endMarker = `===CHATERM_END_${timestamp}_${randomId}===`

    // 改进的命令包装：使用bash确保可靠性和更好的错误处理
    const wrappedCommand = `bash -c 'echo "${startMarker}"; ${commandToExecute}; EXIT_CODE=$?; echo "${endMarker}:$EXIT_CODE"'`

    jumpserverMarkedCommands.set(sessionId, {
      marker: startMarker,
      output: '',
      completed: false,
      lastActivity: Date.now(),
      idleTimer: null
    })

    let lineBuffer = ''
    let commandStarted = false
    let commandCompleted = false
    let exitCode = 0
    let commandEchoFiltered = false

    // 改进的ANSI清理正则表达式
    const cleanAnsiCodes = (text: string): string => {
      return (
        text
          // 清理所有ANSI转义序列
          .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // 通用ANSI序列
          .replace(/\x1B\[[?][0-9]*[hl]/g, '') // 模式设置
          .replace(/\x1B\[K/g, '') // 行擦除
          .replace(/\x1B\[[0-9]+[ABCD]/g, '') // 光标移动
          .replace(/\x1B\]0;[^\x07]*\x07/g, '') // 窗口标题设置
          .replace(/\x1B\[[0-9;]*[JKmsu]/g, '') // 其他控制序列
          // 清理终端提示符相关字符
          .replace(/\x00/g, '') // NULL字符
          .replace(/\r/g, '') // 回车符
          .replace(/\x07/g, '')
      ) // 响铃字符
    }

    // 检测是否为命令回显
    const isCommandEcho = (line: string): boolean => {
      const cleanLine = cleanAnsiCodes(line).trim()
      // 检测包装命令的回显
      if (
        cleanLine.includes('bash -c') ||
        cleanLine.includes(`echo "${startMarker}"`) ||
        cleanLine.includes(commandToExecute) ||
        cleanLine.includes(`echo "${endMarker}:$EXIT_CODE"`) ||
        cleanLine === wrappedCommand.trim()
      ) {
        return true
      }
      return false
    }

    const processLine = (line: string) => {
      const cleanLine = cleanAnsiCodes(line)

      // 检测并过滤命令回显
      if (!commandStarted && !commandEchoFiltered && isCommandEcho(cleanLine)) {
        console.log(`[JumpServer ${sessionId}] 过滤命令回显: ${cleanLine.substring(0, 50)}...`)
        return
      }

      // 检测命令开始标记
      if (cleanLine.includes(startMarker)) {
        commandStarted = true
        commandEchoFiltered = true
        console.log(`[JumpServer ${sessionId}] 检测到命令开始标记`)
        return
      }

      // 检测命令结束标记
      if (cleanLine.includes(endMarker)) {
        console.log(`[JumpServer ${sessionId}] 检测到命令结束标记: ${cleanLine}`)
        const match = cleanLine.match(new RegExp(`${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`))
        if (match && match[1]) {
          exitCode = parseInt(match[1], 10)
          console.log(`[JumpServer ${sessionId}] 命令退出码: ${exitCode}`)
        }

        // 立即完成命令
        if (!commandCompleted) {
          commandCompleted = true
          console.log(`[JumpServer ${sessionId}] 命令执行完成，发送 completed 事件`)

          // 发送剩余的缓冲区内容
          if (lineBuffer && this.isListening) {
            const cleanBufferLine = cleanAnsiCodes(lineBuffer).trim()
            if (cleanBufferLine && !cleanBufferLine.includes(endMarker)) {
              this.emit('line', cleanBufferLine)
            }
          }

          this.emit('completed')
          stream.removeListener('data', dataHandler)
          jumpserverMarkedCommands.delete(sessionId)
        }
        this.emit('continue')
        return
      }

      // 只有在命令开始标记之后且未完成时才发送输出行
      if (commandStarted && !commandCompleted) {
        const trimmedLine = cleanLine.trim()
        if (trimmedLine && !trimmedLine.includes(startMarker) && !trimmedLine.includes(endMarker)) {
          this.emit('line', trimmedLine)
        }
      }
    }

    const dataHandler = (data: Buffer) => {
      if (commandCompleted) return

      const chunk = data.toString()
      this.fullOutput += chunk

      if (!this.isListening) return

      // 处理数据，包括缓冲区中的内容
      let dataStr = lineBuffer + chunk
      const lines = dataStr.split(/\r?\n/)
      lineBuffer = lines.pop() || ''

      // 处理完整的行
      for (const line of lines) {
        processLine(line)
      }

      // 检查缓冲区中是否包含结束标记（处理同行情况）
      if (lineBuffer.includes(endMarker)) {
        console.log(`[JumpServer ${sessionId}] 在缓冲区中检测到结束标记: ${lineBuffer}`)
        processLine(lineBuffer)
        lineBuffer = ''
      }

      // 检查缓冲区中是否包含开始标记（处理同行情况）
      if (!commandStarted && lineBuffer.includes(startMarker)) {
        console.log(`[JumpServer ${sessionId}] 在缓冲区中检测到开始标记: ${lineBuffer}`)
        processLine(lineBuffer)
        lineBuffer = ''
      }
    }

    stream.on('data', dataHandler)

    // 发送命令前先清理可能的残留输出
    console.log(`[JumpServer ${sessionId}] 发送包装命令: ${wrappedCommand}`)
    stream.write(`${wrappedCommand}\r`)

    // 保留超时机制作为备份
    setTimeout(() => {
      if (!commandCompleted) {
        console.log(`[JumpServer ${sessionId}] 命令执行超时，强制完成`)
        commandCompleted = true
        stream.removeListener('data', dataHandler)
        jumpserverMarkedCommands.delete(sessionId)
        this.emit('error', new Error('JumpServer 命令执行超时'))
      }
    }, 30000)
  }
}

// Remote terminal process result Promise type
export type RemoteTerminalProcessResultPromise = RemoteTerminalProcess & Promise<void>

// Merge process and Promise
export function mergeRemotePromise(process: RemoteTerminalProcess, promise: Promise<void>): RemoteTerminalProcessResultPromise {
  const merged = process as RemoteTerminalProcessResultPromise

  // Copy Promise methods
  merged.then = promise.then.bind(promise)
  merged.catch = promise.catch.bind(promise)
  merged.finally = promise.finally.bind(promise)

  return merged
}

// Remote terminal manager class
export class RemoteTerminalManager {
  private terminals: Map<number, RemoteTerminalInfo> = new Map()
  private processes: Map<number, RemoteTerminalProcess> = new Map()
  private nextTerminalId = 1
  private connectionInfo: ConnectionInfo | null = null

  constructor() {
    // Set default connection information
  }

  // Set SSH connection information
  setConnectionInfo(info: ConnectionInfo): void {
    this.connectionInfo = info
  }

  // Create new remote terminal
  async createTerminal(): Promise<RemoteTerminalInfo> {
    if (!this.connectionInfo) {
      throw new Error('Connection information not set, please call setConnectionInfo() first')
    }
    // SSH connection logic
    const existingTerminal = Array.from(this.terminals.values()).find(
      (terminal) =>
        terminal.connectionInfo.host === this.connectionInfo?.host &&
        terminal.connectionInfo.port === this.connectionInfo?.port &&
        terminal.connectionInfo.username === this.connectionInfo?.username
    )

    if (existingTerminal) {
      return existingTerminal
    }

    try {
      let connectResult: { id?: string; status?: string; message?: string; error?: string } | undefined
      // 根据 sshType 选择连接方式
      if (this.connectionInfo.sshType === 'jumpserver') {
        // 使用 JumpServer 连接
        const jumpServerConnectionInfo = {
          id: `jumpserver_${Date.now()}_${Math.random().toString(36).substring(2, 14)}`,
          host: this.connectionInfo.asset_ip!,
          port: this.connectionInfo.port,
          username: this.connectionInfo.username!,
          password: this.connectionInfo.password,
          privateKey: this.connectionInfo.privateKey,
          passphrase: this.connectionInfo.passphrase,
          targetIp: this.connectionInfo.host!
        }

        connectResult = await handleJumpServerConnection(jumpServerConnectionInfo)
        if (!connectResult || connectResult.status !== 'connected') {
          throw new Error('JumpServer 连接失败: ' + (connectResult?.message || '未知错误'))
        }

        // 为 JumpServer 连接设置 ID
        connectResult.id = jumpServerConnectionInfo.id
      } else {
        // 使用标准 SSH 连接
        connectResult = await remoteSshConnect(this.connectionInfo)
        if (!connectResult || !connectResult.id) {
          throw new Error('SSH 连接失败: ' + (connectResult?.error || '未知错误'))
        }
      }

      const terminalInfo: RemoteTerminalInfo = {
        id: this.nextTerminalId++,
        sessionId: connectResult.id,
        busy: false,
        lastCommand: '',
        connectionInfo: this.connectionInfo,
        terminal: {
          show: () => {} // The show method of the remote terminal is a no-op
        }
      }

      this.terminals.set(terminalInfo.id, terminalInfo)
      console.log('SSH connection established successfully, terminal created')
      return terminalInfo
    } catch (error) {
      throw new Error('Failed to create remote terminal: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // Run remote command
  runCommand(terminalInfo: RemoteTerminalInfo, command: string, cwd?: string): RemoteTerminalProcessResultPromise {
    terminalInfo.busy = true
    terminalInfo.lastCommand = command
    const process = new RemoteTerminalProcess()
    this.processes.set(terminalInfo.id, process)
    process.once('error', (error) => {
      terminalInfo.busy = false
      console.error(`Remote terminal ${terminalInfo.id} error:`, error)
    })
    const promise = new Promise<void>((resolve, reject) => {
      process.once('continue', () => {
        resolve()
      })
      process.once('error', (error) => {
        reject(error)
      })
      process.run(terminalInfo.sessionId, command, cwd, terminalInfo.connectionInfo.sshType).catch(reject)
    })
    const result = mergeRemotePromise(process, promise)
    return result
  }

  // 检查进程是否处于热状态
  isProcessHot(terminalId: number): boolean {
    const process = this.processes.get(terminalId)
    return process ? process.isHot : false
  }

  // Get terminal information
  getTerminals(busy: boolean): { id: number; lastCommand: string }[] {
    return Array.from(this.terminals.values())
      .filter((t) => t.busy === busy)
      .map((t) => ({ id: t.id, lastCommand: t.lastCommand }))
  }

  // Check if connected
  isConnected(): boolean {
    return this.terminals.size > 0
  }

  // Get connection status
  getConnectionStatus(): { connected: boolean; terminalCount: number; busyCount: number } {
    const terminals = Array.from(this.terminals.values())
    return {
      connected: terminals.length > 0,
      terminalCount: terminals.length,
      busyCount: terminals.filter((t) => t.busy).length
    }
  }

  // Clean up all connections
  async disposeAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = []
    for (const terminalInfo of this.terminals.values()) {
      disconnectPromises.push(this.disconnectTerminal(terminalInfo.id))
    }
    await Promise.all(disconnectPromises)
    this.terminals.clear()
    this.processes.clear()
    console.log('所有远程终端已关闭。')
  }

  // Disconnect specified terminal connection
  async disconnectTerminal(terminalId: number): Promise<void> {
    const terminalInfo = this.terminals.get(terminalId)
    if (terminalInfo) {
      this.processes.delete(terminalId)
      this.terminals.delete(terminalId)
      try {
        if (terminalInfo.connectionInfo.sshType === 'jumpserver') {
          const { jumpserverConnections, jumpserverShellStreams } = await import('./jumpserverHandle')

          const stream = jumpserverShellStreams.get(terminalInfo.sessionId)
          if (stream) {
            stream.end()
            jumpserverShellStreams.delete(terminalInfo.sessionId)
          }

          const conn = jumpserverConnections.get(terminalInfo.sessionId)
          if (conn) {
            conn.end()
            jumpserverConnections.delete(terminalInfo.sessionId)
          }

          console.log(`JumpServer 终端 ${terminalId} (Session: ${terminalInfo.sessionId}) 已断开.`)
        } else {
          await remoteSshDisconnect(terminalInfo.sessionId)
          console.log(`SSH terminal ${terminalId} (Session: ${terminalInfo.sessionId}) disconnected.`)
        }
      } catch (error) {
        console.error(`Error disconnecting terminal ${terminalId}:`, error)
      }
    }
  }
}
