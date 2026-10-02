#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macOS 手台串口原始探测 v3(只用 Python 标准库, 不需要 pyserial)。

它把「手台连不上」拆成能定位的几层:

  A. 设备不在 USB 总线上 / 挑错了口   -> 看第 1 段 USB 设备树
  B. 在, 但 macOS 读口就报错          -> 脚本会打出 errno 名字(EIO/ENXIO/...)
  C. 在, 读口正常, 但一个字节都不发   -> 分「没碰手台」和「碰了也不发」
  D. 是 macOS 的 CDC 驱动这一层出的错 -> 最后一段 AppleUSBCDC 的内核日志
  E. 设备到底要什么才开始推流         -> 静听/单次开扫描/补发开扫描/只摸手台/发灯光帧, 哪一步开始
  F. 帧收到了但校验和对不上吗         -> 对比「未转义后整帧和==0」与「线上原字节整帧和==0」

(v2 那次已经出现过「设备在推 cmd=0x01 的帧, 但每帧都被判校验和错」, F 就是为此加的。)

用法(先退出游戏/断开手台, 否则串口被占用):

    python3 mac-hw-probe.py
    python3 mac-hw-probe.py /dev/cu.usbmodem3563345B32343

中途会请你用手指在手台上左右来回划(每次几秒), 按屏幕提示做就行。
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
        fr = decode_frames(data)
        if fr:
            say('      拆出 %d 帧: %s' % (len(fr), ' '.join(
                'cmd=0x%02X(%d字节%s)' % (c, len(pl), '' if ok else ',校验和错')
                for c, pl, ok in fr[:8])))
        else:
            say('      收到字节, 但拆不出一帧(不像 Affine/官方协议的帧, 或者只收到半帧)')
    for e in events:
        say('      !! ' + e)


def send_scan(fd):
    """AUTO_AIR_START + AUTO_SCAN_START(Affine 参考实现的开扫描顺序)"""
    return write_all(fd, AFFINE_START, '开扫描(AIR_START+SCAN_START)')


def analyze(data, max_frames=400):
    """拆帧 + 对比两种校验和规则 + 打出前两帧的原始字节。"""
    say('  ---- 收到的数据: %d 字节 ----' % len(data))
    say('  流开头 80 字节: %s' % hexdump(data, 80))
    if len(data) > 100:
        say('  流结尾 20 字节: %s' % hexdump(data[-20:], 20))
    frames = 0
    logical_ok = 0
    wire_ok = 0
    samples = []
    i = 0
    n = len(data)
    while i < n and frames < max_frames:
        if data[i] != 0xFF:
            i += 1
            continue
        start = i
        j = i + 1
        logical = [0xFF]
        bad = False
        while len(logical) < 3 and not bad:
            if j >= n:
                bad = True
                break
            b = data[j]
            j += 1
            if b == 0xFF:
                bad = True
                break
            if b == 0xFD:
                if j >= n:
                    bad = True
                    break
                b = (data[j] + 1) & 0xFF
                j += 1
            logical.append(b)
        if bad or len(logical) < 3:
            i = start + 1
            continue
        size = logical[2]
        while len(logical) < size + 4 and not bad:
            if j >= n:
                bad = True
                break
            b = data[j]
            j += 1
            if b == 0xFF:
                bad = True
                break
            if b == 0xFD:
                if j >= n:
                    bad = True
                    break
                b = (data[j] + 1) & 0xFF
                j += 1
            logical.append(b)
        if bad or len(logical) < size + 4:
            i = start + 1
            continue
        wire = data[start:j]
        frames += 1
        if sum(logical) & 0xFF == 0:
            logical_ok += 1
        if sum(wire) & 0xFF == 0:
            wire_ok += 1
        if len(samples) < 2:
            samples.append((wire, bytes(logical)))
        i = j
    say('  拆出 %d 帧; 校验和对比: 「未转义后整帧和==0」%d 帧, 「线上原字节整帧和==0」%d 帧'
        % (frames, logical_ok, wire_ok))
    for k, pair in enumerate(samples, 1):
        wire, logical = pair
        say('  第 %d 帧 线上字节(%d): %s' % (k, len(wire), hexdump(wire, 64)))
        say('  第 %d 帧 未转义后(%d): %s' % (k, len(logical), hexdump(logical, 64)))
        say('       cmd=0x%02X size=%d 末尾校验字节=0x%02X 未转义和=0x%02X 线上和=0x%02X'
            % (logical[1], logical[2], logical[-1], sum(logical) & 0xFF, sum(wire) & 0xFF))
    if samples:
        logical = samples[0][1]
        pl = logical[3:3 + logical[2]]
        say('  第 1 帧 payload(%d): %s' % (len(pl), ' '.join('%02X' % b for b in pl)))
        if len(pl) >= 32:
            say('      前 32 个=压力值(十进制): %s' % ' '.join('%d' % b for b in pl[:32]))
        if len(pl) > 32:
            say('      第 33 个=天键位图: 0b%s' % format(pl[32], '08b'))
    return frames


def countdown(secs):
    for i in range(secs, 0, -1):
        say('      %d…' % i)
        time.sleep(1)


def full_probe(path):
    say('==== 4. 正式试: %s ====' % path)
    try:
        fd = open_port(path, BAUD, True, False)
    except OSError as e:
        say('  打不开: %s(%s) —— 多半是游戏/别的程序占着这个口'
            % (errno_mod.errorcode.get(e.errno, e.errno), e.strerror))
        return False
    buf = bytearray()
    onset = [None]

    def take(label, secs):
        data, events = listen(fd, secs)
        report(label, data, events)
        if data:
            if onset[0] is None:
                onset[0] = label
            buf.extend(data)
        return data

    try:
        say('  已按 115200 8N1 打开, DTR 置位(和 Windows 参考实现的 SETDTR 一致)')
        write_all(fd, affine_frame(0x04), 'AUTO_SCAN_STOP(先让它回到「没在扫描」)')
        take('[0] 复位后静听 2.0s', 2.0)
        send_scan(fd)
        take('[1] 开扫描 ×1 之后听 3.0s', 3.0)
        if not buf:
            for k in range(6):
                send_scan(fd)
                if take('[2] 补发开扫描 第 %d 次 之后听 0.7s' % (k + 1), 0.7):
                    break
        if not buf:
            say('  >>> [3] 请现在用手指在手台上左右来回划, 持续 5 秒(这一步不写任何东西)…')
            countdown(3)
            take('[3] 只摸手台 → 听 5.0s', 5.0)
        if not buf:
            write_all(fd, LED_FRAME, '灯光帧(黄)')
            take('[4] 发灯光帧(黄) → 听 3.0s', 3.0)
            say('      >>> 顺便看一眼手台灯带有没有变黄')
        if not buf:
            write_all(fd, AIR_LED_FRAME, 'AIR 灯光帧(绿)')
            take('[5] 发 AIR 灯光帧(绿) → 听 3.0s', 3.0)

        if buf:
            say('')
            say('  >>> 数据是在「%s」这一步开始来的' % onset[0])
            analyze(buf)
            say('')
            say('  再摸 3 秒, 看压力值会不会变(确认手台真的在工作)…')
            countdown(3)
            data, events = listen(fd, 3.0)
            if data:
                analyze(data, max_frames=3)
            else:
                say('      这 3 秒没有数据 —— 流可能停了')
        else:
            say('')
            say('  ---- 换一种开法: 控制线全不动 ----')
    finally:
        os.close(fd)

    if not buf:
        time.sleep(0.3)
        if not os.path.exists(path):
            say('  !! 关掉后 %s 消失了 —— 设备在打开串口时重新枚举了' % path)
        try:
            fd = open_port(path, BAUD, False, False)
        except OSError as e:
            say('  重开失败: %s' % e.strerror)
            return False
        try:
            send_scan(fd)
            say('  >>> 请现在摸手台 6 秒…')
            countdown(3)
            data, events = listen(fd, 6.0)
            report('[6] 控制线不动 + 摸手台 → 听 6.0s', data, events)
            if data:
                analyze(data)
                buf.extend(data)
        finally:
            os.close(fd)
    return bool(buf)

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


def decode_frames(data):
    """按 Affine/官方协议拆帧, 返回 [(cmd, payload), ...]。"""
    frames = []
    buf = bytearray()
    esc = False
    for b in data:
        if not buf:
            if b != 0xFF:
                continue
            buf.append(b)
            esc = False
            continue
        if b == 0xFF:
            buf = bytearray([b])
            esc = False
            continue
        if b == 0xFD:
            if esc:
                buf = bytearray()
                esc = False
                continue
            esc = True
            continue
        if esc:
            b = (b + 1) & 0xFF
            esc = False
        buf.append(b)
        if len(buf) >= 3 and len(buf) >= buf[2] + 4:
            frames.append((buf[1], bytes(buf[3:3 + buf[2]]),
                            (sum(buf) & 0xFF) == 0))
            buf = bytearray()
    return frames


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
        say('  手台说话了 —— 请把这整段贴回来, 尤其是下面这三组:')
        say('   - 「数据是在「…」这一步开始来的」: 说明设备要什么才会开始推流;')
        say('   - 「校验和对比」两边的帧数: 哪边等于总帧数, 宿主就该按哪种算法校验')
        say('     (「未转义后整帧和==0」= 官方/Affine 参考实现的算法; 「线上原字节整帧和==0」')
        say('     = 连 0xFD 转义字节也一起算进去。现在宿主只认前一种, 所以两种对不上就会')
        say('     「明明有数据却一帧都不认」);')
        say('   - 「第 1/2 帧 线上字节 / 未转义后」这两行原始字节。')
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
