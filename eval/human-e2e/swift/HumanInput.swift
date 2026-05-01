import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

let source = CGEventSource(stateID: .combinedSessionState)

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func post(_ event: CGEvent?) {
  guard let event else { return }
  event.post(tap: .cghidEventTap)
}

func postToPid(_ event: CGEvent?, pid: Int32) {
  guard let event else { return }
  event.postToPid(pid_t(pid))
}

func sleepBriefly(_ seconds: Double = 0.035) {
  Thread.sleep(forTimeInterval: seconds)
}

func moveMouse(x: Double, y: Double) {
  CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
  CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
  sleepBriefly()
}

func click(x: Double, y: Double) {
  let point = CGPoint(x: x, y: y)
  moveMouse(x: x, y: y)
  post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
  sleepBriefly()
  post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
  sleepBriefly()
}

func keyCode(for key: String) -> CGKeyCode {
  switch key.lowercased() {
  case "a": return 0
  case "s": return 1
  case "d": return 2
  case "f": return 3
  case "h": return 4
  case "g": return 5
  case "z": return 6
  case "x": return 7
  case "c": return 8
  case "v": return 9
  case "b": return 11
  case "q": return 12
  case "w": return 13
  case "e": return 14
  case "r": return 15
  case "y": return 16
  case "t": return 17
  case "1": return 18
  case "2": return 19
  case "3": return 20
  case "4": return 21
  case "6": return 22
  case "5": return 23
  case "=": return 24
  case "9": return 25
  case "7": return 26
  case "-": return 27
  case "8": return 28
  case "0": return 29
  case "]": return 30
  case "o": return 31
  case "u": return 32
  case "[": return 33
  case "i": return 34
  case "p": return 35
  case "enter", "return": return 36
  case "l": return 37
  case "j": return 38
  case "'": return 39
  case "k": return 40
  case ";": return 41
  case "\\": return 42
  case ",": return 43
  case "/": return 44
  case "n": return 45
  case "m": return 46
  case ".": return 47
  case "tab": return 48
  case "space": return 49
  case "`": return 50
  case "delete", "backspace": return 51
  case "escape", "esc": return 53
  default: fail("Unsupported key: \(key)")
  }
}

func flags(from names: [String]) -> CGEventFlags {
  var flags = CGEventFlags()
  for name in names.map({ $0.lowercased() }) {
    switch name {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option": flags.insert(.maskAlternate)
    case "fn": flags.insert(.maskSecondaryFn)
    case "": continue
    default: fail("Unsupported modifier: \(name)")
    }
  }
  return flags
}

func modifierKeyCode(for name: String) -> CGKeyCode? {
  switch name.lowercased() {
  case "cmd", "command": return 55
  case "shift": return 56
  case "ctrl", "control": return 59
  case "alt", "option": return 58
  case "fn": return 63
  case "": return nil
  default: fail("Unsupported modifier: \(name)")
  }
}

func keyTap(_ key: String, modifiers: [String] = []) {
  let code = keyCode(for: key)
  let eventFlags = flags(from: modifiers)
  let modifierCodes = modifiers.compactMap { modifierKeyCode(for: $0) }

  for mod in modifierCodes {
    let down = CGEvent(keyboardEventSource: source, virtualKey: mod, keyDown: true)
    down?.flags = eventFlags
    post(down)
    sleepBriefly(0.012)
  }

  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  down?.flags = eventFlags
  post(down)
  sleepBriefly(0.025)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  up?.flags = eventFlags
  post(up)
  sleepBriefly(0.025)

  for mod in modifierCodes.reversed() {
    let up = CGEvent(keyboardEventSource: source, virtualKey: mod, keyDown: false)
    up?.flags = []
    post(up)
    sleepBriefly(0.012)
  }
}

func keyTapToPid(_ key: String, modifiers: [String] = [], pid: Int32) {
  let code = keyCode(for: key)
  let eventFlags = flags(from: modifiers)
  let modifierCodes = modifiers.compactMap { modifierKeyCode(for: $0) }
  for mod in modifierCodes {
    let down = CGEvent(keyboardEventSource: source, virtualKey: mod, keyDown: true)
    down?.flags = eventFlags
    postToPid(down, pid: pid)
    sleepBriefly(0.012)
  }
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  down?.flags = eventFlags
  postToPid(down, pid: pid)
  sleepBriefly(0.025)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  up?.flags = eventFlags
  postToPid(up, pid: pid)
  sleepBriefly(0.025)
  for mod in modifierCodes.reversed() {
    let up = CGEvent(keyboardEventSource: source, virtualKey: mod, keyDown: false)
    up?.flags = []
    postToPid(up, pid: pid)
    sleepBriefly(0.012)
  }
}

func keyStroke(for scalar: UnicodeScalar) -> (String, [String])? {
  let s = String(scalar)
  if scalar.value >= 65 && scalar.value <= 90 {
    return (s.lowercased(), ["shift"])
  }
  if scalar.value >= 97 && scalar.value <= 122 {
    return (s, [])
  }
  if scalar.value >= 48 && scalar.value <= 57 {
    return (s, [])
  }
  switch s {
  case " ": return ("space", [])
  case "\n": return ("enter", [])
  case ".": return (".", [])
  case ",": return (",", [])
  case "/": return ("/", [])
  case ";": return (";", [])
  case "'": return ("'", [])
  case "[": return ("[", [])
  case "]": return ("]", [])
  case "\\": return ("\\", [])
  case "-": return ("-", [])
  case "=": return ("=", [])
  case "`": return ("`", [])
  case "!": return ("1", ["shift"])
  case "@": return ("2", ["shift"])
  case "#": return ("3", ["shift"])
  case "$": return ("4", ["shift"])
  case "%": return ("5", ["shift"])
  case "^": return ("6", ["shift"])
  case "&": return ("7", ["shift"])
  case "*": return ("8", ["shift"])
  case "(": return ("9", ["shift"])
  case ")": return ("0", ["shift"])
  case "_": return ("-", ["shift"])
  case "+": return ("=", ["shift"])
  case ":": return (";", ["shift"])
  case "\"": return ("'", ["shift"])
  case "?": return ("/", ["shift"])
  case "<": return (",", ["shift"])
  case ">": return (".", ["shift"])
  case "{": return ("[", ["shift"])
  case "}": return ("]", ["shift"])
  case "|": return ("\\", ["shift"])
  case "~": return ("`", ["shift"])
  default: return nil
  }
}

func postUnicodeScalar(_ scalar: UnicodeScalar, pid: Int32? = nil) {
  var value = UniChar(scalar.value)
  let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
  down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
  up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
  if let pid {
    postToPid(down, pid: pid)
    postToPid(up, pid: pid)
  } else {
    post(down)
    post(up)
  }
}

func typeText(_ text: String) {
  for scalar in text.unicodeScalars {
    if scalar == "\n" {
      keyTap("enter")
    } else {
      postUnicodeScalar(scalar)
      Thread.sleep(forTimeInterval: 0.001)
    }
  }
}

func typeTextToPid(_ text: String, pid: Int32) {
  for scalar in text.unicodeScalars {
    if scalar == "\n" {
      keyTapToPid("enter", pid: pid)
    } else {
      postUnicodeScalar(scalar, pid: pid)
      Thread.sleep(forTimeInterval: 0.001)
    }
  }
}

func activatePid(_ pid: Int32) {
  guard let app = NSRunningApplication(processIdentifier: pid) else {
    fail("No running application for pid \(pid)")
  }
  app.activate(options: [.activateIgnoringOtherApps])
  sleepBriefly(0.2)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
  fail("usage: HumanInput.swift <check-permissions|move|click|hotkey|hotkey-pid|key|key-pid|type|type-pid|replace-text|activate-pid> ...")
}

switch command {
case "check-permissions":
  let trusted = AXIsProcessTrusted()
  print("{\"accessibility\":\(trusted ? "true" : "false")}")
  exit(trusted ? 0 : 2)
case "move":
  guard args.count == 3, let x = Double(args[1]), let y = Double(args[2]) else { fail("move requires x y") }
  moveMouse(x: x, y: y)
case "click":
  guard args.count == 3, let x = Double(args[1]), let y = Double(args[2]) else { fail("click requires x y") }
  click(x: x, y: y)
case "hotkey":
  guard args.count == 2 else { fail("hotkey requires combo, e.g. cmd+shift+c") }
  let parts = args[1].split(separator: "+").map(String.init)
  guard let key = parts.last else { fail("missing hotkey key") }
  keyTap(key, modifiers: Array(parts.dropLast()))
case "hotkey-pid":
  guard args.count == 3, let pid = Int32(args[1]) else { fail("hotkey-pid requires pid combo") }
  let parts = args[2].split(separator: "+").map(String.init)
  guard let key = parts.last else { fail("missing hotkey key") }
  keyTapToPid(key, modifiers: Array(parts.dropLast()), pid: pid)
case "key":
  guard args.count == 2 else { fail("key requires key name") }
  keyTap(args[1])
case "key-pid":
  guard args.count == 3, let pid = Int32(args[1]) else { fail("key-pid requires pid key name") }
  keyTapToPid(args[2], pid: pid)
case "type":
  guard args.count >= 2 else { fail("type requires text") }
  typeText(args.dropFirst().joined(separator: " "))
case "type-pid":
  guard args.count >= 3, let pid = Int32(args[1]) else { fail("type-pid requires pid text") }
  typeTextToPid(args.dropFirst(2).joined(separator: " "), pid: pid)
case "replace-text":
  guard args.count >= 5, let pid = Int32(args[1]), let x = Double(args[2]), let y = Double(args[3]) else { fail("replace-text requires pid x y text") }
  activatePid(pid)
  click(x: x, y: y)
  keyTapToPid("a", modifiers: ["cmd"], pid: pid)
  keyTapToPid("delete", pid: pid)
  typeText(args.dropFirst(4).joined(separator: " "))
case "click-type":
  guard args.count >= 5, let x = Double(args[1]), let y = Double(args[2]) else { fail("click-type requires x y text") }
  click(x: x, y: y)
  typeText(args.dropFirst(3).joined(separator: " "))
case "activate-pid":
  guard args.count == 2, let pid = Int32(args[1]) else { fail("activate-pid requires pid") }
  activatePid(pid)
default:
  fail("unknown command: \(command)")
}
