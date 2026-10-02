#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macOS 手台串口原始探测 v2(只用 Python 标准库, 不需要 pyserial)。

v1 只回答「设备有没有回字节」; v2 把「一个字节都没回」拆成能定位的几种:

  A. 设备不在 USB 总线上 / 挑错了口   -> 看第 1 段 USB 设备树
  B. 在, 但 macOS 读口就报错          -> 脚本会打出 errno 名字(EIO/ENXIO/...)
  C. 在, 读口正常, 但一个字节都不发   -> 分「没碰手台」和「碰了也不发」
  D. 是 macOS 的 CDC 驱动这一层出的错 -> 最后一段 AppleUSBCDC 的内核日志

用法(先退出游戏/断开手台, 否则串口被占用):

    python3 mac-hw-probe.py
    python3 mac-hw-probe.py /dev/cu.usbmodem3563345B32343

跑的过程中按屏幕提示做: 会请你用手指在手台上左右来回划 12 秒。
整段输出贴回来就行。macOS 自带 /usr/bin/python3。
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


def touch_test(fd, secs, label):
    say('  >>> 现在开始: 请用一根手指在手台(触摸条)上从左划到右, 再划回来,')
    say('      来回划几次, 持续约 %d 秒(现在就开始, 别等)…' % secs)
    for i in (3, 2, 1):
        say('      %d…' % i)
        time.sleep(1)
    data, events = listen(fd, secs, tick=2.0)
    report(label, data, events)
    return data


def full_probe(path):
    say('==== 4. 正式试: %s ====' % path)
    try:
        fd = open_port(path, BAUD, True, False)
    except OSError as e:
        say('  打不开: %s(%s) —— 多半是游戏/别的程序占着这个口'
            % (errno_mod.errorcode.get(e.errno, e.errno), e.strerror))
        return False
    ok = False
    try:
        say('  已按 115200 8N1 打开, DTR 置位(和 Windows 参考实现的 SETDTR 一致)')
        data, events = listen(fd, 2.0)
        report('静听 2.0s', data, events)
        ok = ok or bool(data)

        write_all(fd, AFFINE_START, 'Affine 开扫描')
        data = touch_test(fd, 12.0, '摸手台 + 听 12.0s')
        ok = ok or bool(data)
        if data:
            return True

        write_all(fd, CHU2_POLL, 'chu2board 0xB0/0xAF')
        data, events = listen(fd, 2.0)
        report('再听 2.0s', data, events)
        ok = ok or bool(data)

        write_all(fd, LED_FRAME, '灯光帧(黄)')
        say('      >>> 请看一眼手台灯带: 有没有变成黄色/绿色? (记住这个结果, 很有用)')
        write_all(fd, AIR_LED_FRAME, 'AIR 灯光帧(绿)')
        data, events = listen(fd, 3.0)
        report('发完灯再听 3.0s', data, events)
        ok = ok or bool(data)
    finally:
        os.close(fd)

    # 有的固件在「打开串口」瞬间会复位一下, 关掉重开再听一次
    time.sleep(0.3)
    if not os.path.exists(path):
        say('  !! 关掉后 %s 消失了 —— 设备在打开串口时重新枚举了' % path)
    try:
        fd = open_port(path, BAUD, True, False)
    except OSError as e:
        say('  重开失败: %s' % e.strerror)
        return ok
    try:
        write_all(fd, AFFINE_START, '重开后开扫描')
        data = touch_test(fd, 6.0, '重开 + 摸手台 + 听 6.0s')
        ok = ok or bool(data)
    finally:
        os.close(fd)

    if not ok:
        # 控制线一点不动再来一次(排除 DTR/RTS 的锅)
        say('  ---- 换一种开法: 控制线全不动 ----')
        try:
            fd = open_port(path, BAUD, False, False)
        except OSError as e:
            say('  打不开: %s' % e.strerror)
            return False
        try:
            write_all(fd, AFFINE_START, 'Affine 开扫描')
            data = touch_test(fd, 6.0, '控制线不动 + 摸手台 + 听 6.0s')
            ok = ok or bool(data)
        finally:
            os.close(fd)
    return ok


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
        say('  有字节回来了: 上面 [ ] 里就是设备说的话。这是协议层的问题, 把这整段贴回来。')
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
