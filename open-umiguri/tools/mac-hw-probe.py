#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macOS 手台串口原始探测(只用 Python 标准库, 不需要 pyserial)。

宿主连不上手台时, 先用它分清问题在哪一层:

    设备一个字节都没回  -> 线 / USB 驱动 / 固件在 macOS 上的兼容性
    设备回了字节        -> 协议层面(宿主的命令或解码)

用法(先退出游戏, 或在游戏里断开手台, 否则串口被占用):

    python3 mac-hw-probe.py                    # 自动挑 usbmodem / usbserial 口
    python3 mac-hw-probe.py /dev/cu.usbmodem1234

每一种开法都做: 静听 -> 发 Affine 的 AUTO_AIR_START + AUTO_SCAN_START -> 再听
-> 发 chu2board 的 0xB0 握手 + 0xAF 问 API 版本 -> 再听, 收到的原始字节按
十六进制打印。把整段输出贴回来即可。

macOS 自带 /usr/bin/python3(缺的话 xcode-select --install 会装)。
"""
import fcntl
import glob
import os
import select
import struct
import sys
import termios
import time

# Darwin(sys/ttycom.h)的 ioctl 常量; termios 里有就用系统的
TIOCM_DTR = 0x0002
TIOCM_RTS = 0x0004
TIOCMBIS = getattr(termios, 'TIOCMBIS', 0x8004746C)  # _IOW('t', 108, int) 置位
TIOCMBIC = getattr(termios, 'TIOCMBIC', 0x8004746B)  # _IOW('t', 107, int) 清位

AFFINE_START = bytes([
    0xFF, 0x06, 0x00, 0xFB,  # AUTO_AIR_START
    0xFF, 0x03, 0x00, 0xFE,  # AUTO_SCAN_START
])
CHU2_POLL = bytes([0xB0, 0xAF])  # 握手 + 问 API 版本

BAUD_MAIN = 115200
BAUD_EXTRA = (9600, 921600)


def list_ports():
    ports = sorted(glob.glob('/dev/cu.*'))
    print('系统里的串口(/dev/cu.*):')
    for p in ports:
        print('    ' + p)
    print('')
    return ports


def choose_port(ports):
    cand = [p for p in ports if 'usbmodem' in p or 'usbserial' in p or 'wchusb' in p]
    if not cand:
        sys.exit('没找到 usbmodem/usbserial 口 —— 手台插好了吗? 也可以把端口名当参数传进来')
    if len(cand) > 1:
        print('候选口不止一个, 取第一个; 不确定就把端口名当参数传进来: %s' % cand)
        print('')
    return cand[0]


def open_port(path, baud, dtr, rts):
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    fcntl.fcntl(fd, fcntl.F_SETFL, 0)  # 去掉 O_NONBLOCK(和宿主一致)
    attr = termios.tcgetattr(fd)
    cc = attr[6]
    # raw: 关掉所有处理; 8N1 + CREAD/CLOCAL(不认载波); baud 直接写数值(Darwin 的 Bxxx 就是数值)
    try:
        termios.tcsetattr(fd, termios.TCSANOW,
                          [0, 0, termios.CS8 | termios.CREAD | termios.CLOCAL, 0, baud, baud, cc])
    except (OSError, termios.error) as e:
        print('    注意: 设置 8N1/%d 失败(%s), 继续跑' % (baud, e))
    bits = (TIOCM_DTR if dtr else 0) | (TIOCM_RTS if rts else 0)
    try:
        if bits:
            fcntl.ioctl(fd, TIOCMBIS, struct.pack('i', bits))
        else:
            fcntl.ioctl(fd, TIOCMBIC, struct.pack('i', TIOCM_DTR | TIOCM_RTS))
    except OSError as e:
        print('    注意: 设置控制线失败(%s), 这一轮的结果可能不准' % e)
    return fd


def listen(fd, secs):
    out = bytearray()
    end = time.time() + secs
    while True:
        left = end - time.time()
        if left <= 0:
            return bytes(out)
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return bytes(out)
        out += chunk


def hexdump(data):
    if not data:
        return '(没收到任何字节)'
    head = ' '.join('%02X' % b for b in data[:48])
    if len(data) > 48:
        return '%s ...(共 %d 字节)' % (head, len(data))
    return '%s (共 %d 字节)' % (head, len(data))


def attempt(path, baud, dtr, rts):
    tag = ('DTR' + ('+RTS' if rts else '')) if dtr else '不动控制线'
    print('--- %d baud, %s ---' % (baud, tag))
    try:
        fd = open_port(path, baud, dtr, rts)
    except OSError as e:
        print('    打不开: %s(多半是游戏/别的程序占着串口)' % e)
        return False
    try:
        time.sleep(0.1)
        got = listen(fd, 1.0)
        print('    静听 1.0s       : %s' % hexdump(got))
        if got:
            return True
        os.write(fd, AFFINE_START)
        got = listen(fd, 1.5)
        print('    发 Affine 开扫描 : %s' % hexdump(got))
        if got:
            return True
        os.write(fd, CHU2_POLL)
        got = listen(fd, 0.6)
        print('    发 0xB0/0xAF    : %s' % hexdump(got))
        return bool(got)
    finally:
        os.close(fd)


def main():
    if sys.platform != 'darwin':
        sys.exit('这个脚本是给 macOS 用的(ioctl 常量是 Darwin 的)')
    ports = list_ports()
    path = sys.argv[1] if len(sys.argv) > 1 else choose_port(ports)
    print('端口: %s' % path)
    print('')

    # 115200 下三种控制线开法都跑一遍(好对比 DTR/RTS 有没有影响), 有回应就停
    for dtr, rts in ((False, False), (True, False), (True, True)):
        if attempt(path, BAUD_MAIN, dtr, rts):
            print('')
            print('>>> 这个组合有回应, 上面就是设备说的话。')
            return
    for baud in BAUD_EXTRA:
        if attempt(path, baud, True, True):
            print('')
            print('>>> %d baud 下有回应。' % baud)
            return
    print('')
    print('>>> 所有组合都没收到一个字节: 问题在系统/线材/驱动/固件这一层, 不是宿主的协议代码。')
    print('    顺手把 system_profiler SPUSBDataType 里手台那几行也贴上来。')


if __name__ == '__main__':
    main()
