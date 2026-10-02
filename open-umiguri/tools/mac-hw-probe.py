#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macOS 手台串口原始探测 v4(只用 Python 标准库, 不需要 pyserial)。

手台「连不上」可以卡在好几层, 这个脚本从底往上逐层问:

  A. 设备不在 USB 总线上 / 挑错了口   -> 看第 1 段 USB 设备树
  B. 在, 但 macOS 读口就报错          -> 打出 errno 名字(EIO/ENXIO/...)
  C. 在, 读口正常, 但一个字节都不发   -> 分「没碰手台」和「碰了也不发」
  D. 是 macOS 的 CDC 驱动这一层出的错 -> 最后一段 AppleUSBCDC 的内核日志
  E. 打开串口到「设备开始推帧」要多久  -> 第 [0] 步什么都不发, 计时到第一字节
  F. 帧到底多长、校验和怎么算         -> 按 0xFF 切帧, 打段长统计 + 候选校验和规则的吻合数

v3 的教训: 按 size 字段推出 37 字节帧长是错的(真实帧 38 字节, 于是每帧都错位 1 字节,
校验和自然全对不上); 而且那一轮 32 个压力值全是 0xFE(手压着触摸条/饱和), 数据没变化。
所以 v4 改成用 0xFF 切帧(固件载荷里不出现 0xFF), 并且分「手离开 / 按住一格 / 左右来回划」
三段采样, 好对比压力值。

用法(先退出游戏/断开手台, 否则串口被占用):

    python3 mac-hw-probe.py
    python3 mac-hw-probe.py /dev/cu.usbmodem3563345B32343

跑的时候按屏幕提示做(会请你手离开触摸条、按住最左边一格、左右来回划)。
整段输出贴回来即可。macOS 自带 /usr/bin/python3。
"""
import errno as errno_mod
import fcntl
import glob
import os
import re
import select
import struct
import subprocess
import sys
import termios
import time

# Darwin(sys/ttycom.h)的 ioctl 常量; termios 里有就用系统的
TIOCM_DTR = 0x0002
TIOCM_RTS = 0x0004
TIOCMBIS = getattr(termios, 'TIOCMBIS', 0x8004746C)
TIOCMBIC = getattr(termios, 'TIOCMBIC', 0x8004746B)

BAUD = 115200
# Affine_IO/chuniio: slider_start_air_scan() + slider_start_scan()
AFFINE_START = bytes([0xFF, 0x06, 0x00, 0xFB, 0xFF, 0x03, 0x00, 0xFE])
CHU2_POLL = bytes([0xB0, 0xAF])  # chu2board 的握手 + 问 API 版本
# 手台可能的 USB 标识(QHPaeek/Affine_IO chuniio/test.c 里写死的)
AFFINE_VID = 0xAFF1
AFFINE_PIDS = (0x52A4, 0x52A7)

CAND_HINT = ('usbmodem', 'usbserial', 'wchusb', 'SLAB_USBtoUART')


def say(msg=''):
    print(msg)
    sys.stdout.flush()


def hexdump(data, limit=32):
    if not data:
        return '(没收到任何字节)'
    head = ' '.join('%02X' % b for b in data[:limit])
    if len(data) > limit:
        return '%s ...(共 %d 字节)' % (head, len(data))
    return '%s (共 %d 字节)' % (head, len(data))


def escape(b):
    if b == 0xFF or b == 0xFD:
        return bytes([0xFD, b - 1])
    return bytes([b])


def affine_frame(cmd, payload=b''):
    """按 Affine/官方协议组帧: FF cmd size payload... checksum(整帧字节和为 0)。"""
    out = bytearray([0xFF])
    total = 0xFF
    for b in bytes([cmd, len(payload)]) + payload:
        total = (total + b) & 0xFF
        out += escape(b)
    out += escape((-total) & 0xFF)
    return bytes(out)


LED_FRAME = affine_frame(0x02, bytes([0x28]) + bytes([0xFF, 0xE0, 0x00]) * 32)
AIR_LED_FRAME = affine_frame(0x07, bytes([0x00, 0xFF, 0x40]))


def sh(cmd, timeout=90):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        return p.stdout.decode('utf-8', 'replace')
    except Exception as e:
        return '(跑 %s 失败: %s)' % (' '.join(cmd), e)


def ports():
    cu = sorted(glob.glob('/dev/cu.*'))
    tty = sorted(glob.glob('/dev/tty.*'))
    return cu, tty


def candidates(cu, tty):
    out = []
    for p in cu + tty:
        base = os.path.basename(p)
        if any(h in base for h in CAND_HINT):
            out.append(p)
    return out


# ---------------------------------------------------------------- 系统层信息

def dump_ports(cu, tty):
    say('==== 1. 系统里的串口 ====')
    say('  /dev/cu.*  (callout, 宿主用的就是这种):')
    for p in cu:
        say('      ' + p)
    say('  /dev/tty.* (dial-in):')
    for p in tty:
        say('      ' + p)
    say('')


KEEP_SUB = ('Product ID', 'Vendor ID', 'Manufacturer', 'Serial Number', 'Speed',
            'Current Available', 'Current Required', 'Location ID', 'Version',
            'Bus Power', 'Built-in')


def filter_usb_tree(text):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.endswith(':') or any(s.split(':')[0].startswith(k) for k in KEEP_SUB):
            out.append(line.rstrip())
    return out or text.splitlines()


def dump_usb_tree():
    say('==== 2. USB 设备树(手台应该在这里, 名字里带 Linnea / idVendor = %d)===='
        % AFFINE_VID)
    raw = sh(['system_profiler', 'SPUSBDataType'])
    for line in filter_usb_tree(raw):
        say(line)
    say('')
    say('  ---- ioreg: USB 设备(带 VID/PID/序列号)----')
    raw = sh(['ioreg', '-p', 'IOUSB', '-w0', '-l'])
    for line in raw.splitlines():
        s = line.strip()
        if s.startswith('+-o') or '"idVendor"' in s or '"idProduct"' in s \
                or 'USB Product Name' in s or 'USB Vendor Name' in s \
                or 'kUSBSerialNumberString' in s:
            say('  ' + s)
    say('')
    say('  ---- ioreg: 哪个 /dev/cu 挂在哪个 USB 设备上(AppleUSBCDCACMData)----')
    raw = sh(['ioreg', '-c', 'AppleUSBCDCACMData', '-w0', '-l'])
    hits = [l.strip() for l in raw.splitlines()
            if 'IOCalloutDevice' in l or 'IODialinDevice' in l
            or 'USB Product Name' in l or '"idVendor"' in l or '+-o' in l]
    if hits:
        for line in hits:
            say('  ' + line)
    else:
        say('  (没有 AppleUSBCDCACMData 实例 —— 说明没有口挂在系统自带的 CDC 驱动上)')
    say('')


def dump_kernel_log():
    say('==== 3. 内核日志里和 USB 串口有关的几行(可能要等十几秒)====')
    pred = ('eventMessage CONTAINS[c] "usbmodem" OR '
            'eventMessage CONTAINS[c] "AppleUSBACM" OR '
            'eventMessage CONTAINS[c] "AppleUSBCDC" OR '
            'eventMessage CONTAINS[c] "AppleUSBHostPort"')
    out = sh(['log', 'show', '--last', '10m', '--predicate', pred,
              '--style', 'compact'], timeout=120)
    lines = [l for l in out.splitlines() if l.strip()]
    if not lines:
        say('  (没捞到相关内容)')
    else:
        for line in lines[-40:]:
            say('  ' + line)
    say('')


# ---------------------------------------------------------------- 串口试验

def open_port(path, baud, dtr, rts):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    fcntl.fcntl(fd, fcntl.F_SETFL, 0)  # 去掉 O_NONBLOCK(和宿主/pyserial 一致)
    attr = termios.tcgetattr(fd)
    cc = attr[6]
    # raw: 关掉所有处理; 8N1 + CREAD/CLOCAL; baud 直接写数值(Darwin 的 Bxxx 就是数值)
    termios.tcsetattr(fd, termios.TCSANOW,
                      [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL,
                       0, baud, baud, cc])
    bits = (TIOCM_DTR if dtr else 0) | (TIOCM_RTS if rts else 0)
    if bits:
        fcntl.ioctl(fd, TIOCMBIS, struct.pack('i', bits))
    else:
        fcntl.ioctl(fd, TIOCMBIC, struct.pack('i', TIOCM_DTR | TIOCM_RTS))
    return fd


def listen(fd, secs, tick=0):
    """听 secs 秒。返回 (收到的字节, 事件说明)。tick>0 时每 tick 秒报一次进度。"""
    out = bytearray()
    events = []
    started = time.time()
    end = started + secs
    while True:
        left = end - time.time()
        if left <= 0:
            break
        step = left if tick <= 0 else min(tick, left)
        ready, _, _ = select.select([fd], [], [], step)
        if not ready:
            if tick > 0:
                say('      +%4.1fs 已收到 %d 字节' % (time.time() - started, len(out)))
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError as e:
            events.append('读失败 %s(%s)'
                          % (errno_mod.errorcode.get(e.errno, e.errno), e.strerror))
            break
        if not chunk:
            events.append('read 返回 0(口被挂断?)')
            break
        out += chunk
    return bytes(out), events


def write_all(fd, data, label):
    try:
        os.write(fd, data)
        say('  [发 %s]: 已发 %d 字节 %s' % (label, len(data), hexdump(data, 8)))
        return True
    except OSError as e:
        say('  [发 %s]: 写失败 %s(%s)'
            % (label, errno_mod.errorcode.get(e.errno, e.errno), e.strerror))
        return False


def report(label, data, events):
    say('  [%s]: %s' % (label, hexdump(data)))
    if data:
        say('      按 0xFF 切出 %d 段(段长/校验和见后面的帧分析)' % len(split_by_sync(data)))
    for e in events:
        say('      !! ' + e)


def send_scan(fd):
    """AUTO_AIR_START + AUTO_SCAN_START(Affine 参考实现的开扫描顺序)"""
    return write_all(fd, AFFINE_START, '开扫描(AIR_START+SCAN_START)')


def send_scan(fd):
    """AUTO_AIR_START + AUTO_SCAN_START(Affine 参考实现的开扫描顺序)"""
    return write_all(fd, AFFINE_START, '开扫描(AIR_START+SCAN_START)')


def countdown(secs):
    for i in range(secs, 0, -1):
        say('      %d…' % i)
        time.sleep(1)


def split_by_sync(data):
    """按 0xFF 切帧。

    实测固件的载荷里根本不出现 0xFF/0xFD(压力值上限就是 0xFE), 所以 0xFF 只可能是帧首,
    这样切出来的长度直接告诉我们真实帧长 —— 比按 size 字节推算可靠。
    """
    idx = [i for i, b in enumerate(data) if b == 0xFF]
    return [data[idx[k]:idx[k + 1]] for k in range(len(idx) - 1)]


def checksum_rules():
    """候选校验和规则: (名字, 判断函数), 帧 = 以 0xFF 开头的一段。

    实测固件发出来的帧看着像 38 字节: FF 01 21 <32 压力> <air> <x> <y>,
    其中 x 恰好等于「sync + size + 32 压力 + air」(就是漏算了 cmd 那 1 个字节),
    y 一直是 0x00。这里把可能的算法都列出来, 谁吻合 100% 就是它。"""
    def s(xs):
        return sum(xs) & 0xFF

    return (
        ('整帧(含末尾)字节和 == 0                    [官方/Affine 发送侧]',
         lambda f: len(f) > 3 and sum(f) & 0xFF == 0),
        ('倒数第二字节 == sync+size+载荷            [疑似真实算法: 漏掉 cmd]',
         lambda f: len(f) > 4 and s(f[0:1] + f[2:-2]) == f[-2]),
        ('倒数第二字节 == cmd+size+载荷(含 cmd)',
         lambda f: len(f) > 4 and s(f[1:-2]) == f[-2]),
        ('倒数第二字节 == sync+cmd+size+载荷(含 sync)',
         lambda f: len(f) > 4 and s(f[:-2]) == f[-2]),
        ('倒数第二字节 == size+载荷(不含 sync/cmd)',
         lambda f: len(f) > 4 and s(f[2:-2]) == f[-2]),
        ('末尾字节 == sync+size+载荷+倒数第二      [同上但校验在最后]',
         lambda f: len(f) > 4 and s(f[0:1] + f[2:-1]) == f[-1]),
        ('末尾字节 == cmd+size+载荷+倒数第二',
         lambda f: len(f) > 4 and s(f[1:-1]) == f[-1]),
        ('末尾字节 == 前面所有字节和(含 sync)',
         lambda f: len(f) > 3 and s(f[:-1]) == f[-1]),
        ('末尾字节 == -前面所有字节和(含 sync)',
         lambda f: len(f) > 3 and (-sum(f[:-1])) & 0xFF == f[-1]),
        ('末尾字节 == 32 个压力值之和',
         lambda f: len(f) >= 36 and s(f[3:35]) == f[-1]),
        ('倒数第二字节 == 32 个压力值之和',
         lambda f: len(f) >= 36 and s(f[3:35]) == f[-2]),
        ('末尾字节恒为 0(像分隔符)',
         lambda f: len(f) > 3 and f[-1] == 0),
        ('末两字节(小端 16 位) == 前面字节和',
         lambda f: len(f) > 5 and (sum(f[:-2]) & 0xFFFF) == (f[-2] | (f[-1] << 8))),
        ('末两字节(大端 16 位) == 前面字节和',
         lambda f: len(f) > 5 and (sum(f[:-2]) & 0xFFFF) == ((f[-2] << 8) | f[-1])),
    )

def frame_report(label, data):
    """切帧 + 打印前几帧原始字节 + 压力值 + 各候选校验和规则的吻合数。"""
    frames = split_by_sync(data)
    say('  ---- %s: %d 字节, 按 0xFF 切出 %d 段 ----' % (label, len(data), len(frames)))
    if not frames:
        return frames
    hist = {}
    for f in frames:
        hist[len(f)] = hist.get(len(f), 0) + 1
    say('  段长统计: %s' % ', '.join('%d字节×%d' % kv for kv in sorted(hist.items())))
    for k in range(min(2, len(frames))):
        f = frames[len(frames) // 2 + k] if len(frames) > 3 else frames[k]
        say('  第 %d 段(%d 字节): %s' % (k + 1, len(f), hexdump(f, 64)))
        if len(f) >= 36:
            say('       前 32 个压力值: %s' % ' '.join('%d' % b for b in f[3:35]))
            say('       第 33~末尾字节: %s' % ' '.join('%02X' % b for b in f[35:]))
    for name, fn in checksum_rules():
        hit = 0
        for f in frames:
            try:
                if fn(f):
                    hit += 1
            except IndexError:
                pass
        say('  规则「%s」吻合 %d/%d 段' % (name, hit, len(frames)))
    return frames


def full_probe(path):
    say('==== 4. 正式试: %s ====' % path)
    try:
        fd = open_port(path, BAUD, True, False)
    except OSError as e:
        say('  打不开: %s(%s) —— 多半是游戏/别的程序占着这个口'
            % (errno_mod.errorcode.get(e.errno, e.errno), e.strerror))
        return False
    phases = []
    started = time.time()

    def take(label, secs):
        data, events = listen(fd, secs)
        report(label, data, events)
        if data:
            phases.append((label, data))
        return data

    try:
        say('  已按 115200 8N1 打开, DTR 置位; 下面第 [0] 步什么都不发, 量一下「打开到第一字节」要多久')
        say('  [0] 什么都不发, 最多听 20s(收到第一字节立刻停)…')
        t0 = time.time()
        data, events = listen(fd, 20.0, tick=2.0)
        say('      第一字节来得耗时 = %s' % ('%.1fs' % (time.time() - t0) if data else '20s 内没有'))
        if data:
            phases.append(('[0] 打开后直接听', data))
        write_all(fd, affine_frame(0x04), 'AUTO_SCAN_STOP')
        take('[1] AUTO_SCAN_STOP 之后听 1.5s', 1.5)
        send_scan(fd)
        take('[2] 开扫描之后听 1.5s', 1.5)

        say('  >>> [A] 请把手完全离开手台的触摸条(可以握着两侧外壳, 但别碰触摸面)…')
        countdown(3)
        take('[A] 手离开触摸条 → 听 2.5s', 2.5)
        say('  >>> [B] 请只用一个手指按住触摸条最左边那一格, 按住别动…')
        countdown(3)
        take('[B] 按住最左边一格 → 听 2.5s', 2.5)
        say('  >>> [C] 请用一个手指从左慢慢划到右, 再划回来…')
        countdown(3)
        take('[C] 左右来回划 → 听 3.0s', 3.0)
        say('')
        say('  ===== 各段帧分析 =====')
        for label, data in phases:
            frame_report(label, data)
        say('')
        say('  灯光那一步还是照旧(顺便看灯带变不变色):')
        write_all(fd, LED_FRAME, '灯光帧(黄)')
        write_all(fd, AIR_LED_FRAME, 'AIR 灯光帧(绿)')
        take('[D] 发完灯光帧 → 听 1.5s', 1.5)
    finally:
        os.close(fd)

    if not phases:
        time.sleep(0.3)
        say('')
        say('  ---- 一个字节都没有, 换一种开法再试: 控制线全不动 ----')
        try:
            fd = open_port(path, BAUD, False, False)
        except OSError as e:
            say('  重开失败: %s' % e.strerror)
            return False
        try:
            say('  >>> 请现在摸手台 6 秒…')
            countdown(3)
            data, events = listen(fd, 6.0)
            report('[E] 控制线不动 → 听 6.0s', data, events)
            if data:
                frame_report('[E] 控制线不动', data)
                phases.append(('[E]', data))
        finally:
            os.close(fd)
    say('  (整段跑完, 共 %.0f 秒)' % (time.time() - started))
    return bool(phases)

def quick_probe(path):
    try:
        fd = open_port(path, BAUD, True, False)
    except OSError as e:
        say('  %-42s 打不开: %s' % (path, e.strerror))
        return False
    try:
        data, events = listen(fd, 1.5)
        if data:
            say('  %-42s 静听就有数据: %s' % (path, hexdump(data)))
            return True
        write_all(fd, AFFINE_START, 'Affine 开扫描')
        data, events = listen(fd, 2.0)
        if data:
            say('  %-42s 回数据: %s' % (path, hexdump(data)))
            return True
        say('  %-42s 没数据%s' % (path, ('  [' + '; '.join(events) + ']') if events else ''))
        return False
    finally:
        os.close(fd)


def main():
    if sys.platform != 'darwin':
        sys.exit('这个脚本是给 macOS 用的(ioctl 常量是 Darwin 的)')
    say('macOS 手台探测 v2  |  ' + sh(['sw_vers', '-productVersion']).strip()
        + ' / ' + sh(['uname', '-m']).strip())
    say('')
    cu, tty = ports()
    dump_ports(cu, tty)
    dump_usb_tree()
    dump_kernel_log()

    cand = candidates(cu, tty)
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg and not arg.startswith('/dev/'):
        # 常见坑: 把命令里 '#' 后面的说明一起复制进来了('#' 在 zsh 里不是注释)
        say('参数 %r 不像端口名(要以 /dev/ 开头), 忽略它, 自动挑口' % arg)
        say('')
        arg = ''
    if arg:
        if not os.path.exists(arg):
            sys.exit('没有这个串口: %s' % arg)
        main_port = arg
    elif cand:
        main_port = cand[0]
        if len(cand) > 1:
            say('候选口不止一个, 拿第一个当主测试对象, 其它的做快测: %s' % (cand,))
            say('')
    else:
        sys.exit('没找到 usbmodem/usbserial 口 —— 手台插好了吗?')

    got = full_probe(main_port)

    others = [p for p in cand if p != main_port]
    if others:
        say('')
        say('==== 5. 其它候选口(快测)====')
        for p in others:
            if quick_probe(p):
                got = True

    say('')
    say('==== 6. 结果怎么看 ====')
    if got:
        say('  手台说话了 —— 请把这整段贴回来, 重点是:')
        say('   - 第 [0] 步「第一字节来得耗时」: 设备是插上就能推, 还是要等一阵子;')
        say('   - 各段的「段长统计」: 真实帧长是多少字节')
        say('     (上一轮我们按 size 字段推成 37, 实际 38, 每帧都错位, 所以校验和全错);')
        say('   - 「规则「…」吻合 N/M 段」里 N 等于 M 的那条: 那就是固件真实的校验和算法,')
        say('     宿主按它校验就能收下每一帧;')
        say('   - 三段采样的「前 32 个压力值」: 手离开时是什么、按住一格时是什么。')
    else:
        say('  一个字节都没有。请对照上面三段系统信息:')
        say('   a) USB 设备树里没有 Linnea / idVendor = %d 的设备:' % AFFINE_VID)
        say('      macOS 根本没认出这是手台(或者你插的是别的东西) —— 换个 USB 口重插,')
        say('      别走集线器/扩展坞, 再跑一次; 也就是「换线」这次真的有意义。')
        say('   b) 树里有, 但后面出现了 !! 读失败 EIO/ENXIO:')
        say('      macOS 自带 CDC 驱动这一层收不了数据(固件兼容性), 属固件/驱动问题。')
        say('   c) 树里有, 读口干净, 摸着手台也不发:')
        say('      设备侧不发数据。请把同一个手台插到 Windows 机器上, 用 Affine_IO')
        say('      Releases 里的 chuni_test.exe 试: 那边也不动 -> 手台/固件本身的问题;')
        say('      那边正常 -> 就是 macOS 的 CDC/固件兼容, 拿这份输出去问固件作者。')
        say('   d) 顺手记一下上面「灯光帧」那步: 灯带变色了吗? 这能区分「发得出去但收不回来」。')


if __name__ == '__main__':
    main()
