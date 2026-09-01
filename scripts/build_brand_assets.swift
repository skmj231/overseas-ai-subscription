import AppKit

let args = CommandLine.arguments
guard args.count == 3 || args.count == 4 else {
  fputs("usage: build_brand_assets.swift <bell.png> <output-directory> [favicon.png]\n", stderr)
  exit(1)
}

let bellURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2], isDirectory: true)
let favicon = args.count == 4 ? NSImage(contentsOfFile: args[3]) : nil
guard let bell = NSImage(contentsOf: bellURL) else {
  fputs("could not load bell image\n", stderr)
  exit(1)
}

let bellContentRect: NSRect = {
  guard let data = bell.tiffRepresentation, let rep = NSBitmapImageRep(data: data) else { return .zero }
  var minX = rep.pixelsWide, minY = rep.pixelsHigh, maxX = 0, maxY = 0
  for y in 0..<rep.pixelsHigh {
    for x in 0..<rep.pixelsWide {
      if (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.02 {
        minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y)
      }
    }
  }
  return NSRect(x:minX, y:minY, width:maxX-minX+1, height:maxY-minY+1)
}()

try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

func color(_ value: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(
    red: CGFloat((value >> 16) & 0xff) / 255,
    green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255,
    alpha: alpha
  )
}

let forest = color(0x06251D)
let forestDark = color(0x010D0A)
let forestLight = color(0x0A3328)
let cream = color(0xF7F2E8)
let muted = color(0xB9C7BE)
let gold = color(0xE2B84E)

func save(_ image: NSImage, name: String) throws {
  guard let data = image.tiffRepresentation,
        let rep = NSBitmapImageRep(data: data),
        let png = rep.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "DonnaBrand", code: 1)
  }
  try png.write(to: outputURL.appendingPathComponent(name))
}

func canvas(width: Int, height: Int, draw: () -> Void) -> NSImage {
  let image = NSImage(size: NSSize(width: width, height: height))
  image.lockFocus()
  NSGraphicsContext.current?.imageInterpolation = .high
  draw()
  image.unlockFocus()
  return image
}

func roundedBackground(_ rect: NSRect, radius: CGFloat) {
  let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
  path.addClip()
  NSGradient(starting: forest, ending: forestDark)?.draw(in: path, angle: -76)

  color(0xFFFFFF, 0.10).setStroke()
  path.lineWidth = max(1, rect.width * 0.003)
  path.stroke()
}

func drawBell(in rect: NSRect, shadow: Bool = true) {
  if shadow {
    let effect = NSShadow()
    effect.shadowColor = color(0x000000, 0.42)
    effect.shadowBlurRadius = rect.width * 0.07
    effect.shadowOffset = NSSize(width: 0, height: -rect.height * 0.035)
    NSGraphicsContext.saveGraphicsState()
    effect.set()
    bell.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
  } else {
    bell.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
  }
}

func drawBellEdgeToEdge(in rect: NSRect) {
  bell.draw(in: rect, from: bellContentRect, operation: .sourceOver, fraction: 1)
}

func text(_ value: String, at point: NSPoint, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
  let paragraph = NSMutableParagraphStyle()
  paragraph.lineBreakMode = .byWordWrapping
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size, weight: weight),
    .foregroundColor: color,
    .paragraphStyle: paragraph
  ]
  value.draw(at: point, withAttributes: attrs)
}

func roundRect(_ rect: NSRect, radius: CGFloat, fill: NSColor, stroke: NSColor? = nil) {
  let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
  fill.setFill(); path.fill()
  if let stroke { stroke.setStroke(); path.lineWidth = 1; path.stroke() }
}

func makeIcon(_ size: Int) -> NSImage {
  canvas(width: size, height: size) {
    let full = NSRect(x: 0, y: 0, width: size, height: size)
    roundedBackground(full.insetBy(dx: CGFloat(size) * 0.025, dy: CGFloat(size) * 0.025), radius: CGFloat(size) * 0.22)
    let inset = CGFloat(size) * 0.145
    drawBell(in: full.insetBy(dx: inset, dy: inset * 0.88))
  }
}

func makeToolbarIcon(_ size: Int) -> NSImage {
  canvas(width: size, height: size) {
    if let favicon {
      favicon.draw(in:NSRect(x:0,y:0,width:size,height:size), from:.zero, operation:.sourceOver, fraction:1)
      return
    }
    let full = NSRect(x:0, y:0, width:size, height:size)
    let tile = NSBezierPath(roundedRect: full, xRadius:CGFloat(size) * 0.22, yRadius:CGFloat(size) * 0.22)
    forestDark.setFill(); tile.fill()
    let inset = CGFloat(size) * 0.055
    drawBellEdgeToEdge(in: full.insetBy(dx:inset, dy:inset))
  }
}

func makeBareBell(_ size: Int) -> NSImage {
  canvas(width:size, height:size) {
    let inset = CGFloat(size) * 0.04
    drawBellEdgeToEdge(in:NSRect(x:inset, y:inset, width:CGFloat(size)-inset*2, height:CGFloat(size)-inset*2))
  }
}

let icon1024 = makeIcon(1024)
try save(icon1024, name: "donna-app-icon-1024.png")
for size in [16, 32, 48, 128, 180, 256] {
  try save(makeIcon(size), name: "donna-app-icon-\(size).png")
}
for size in [16, 32, 48, 128, 180, 256] {
  try save(makeToolbarIcon(size), name: "donna-toolbar-icon-\(size).png")
}
for size in [16, 48, 128] {
  try save(makeBareBell(size), name: "donna-bell-symbol-\(size).png")
}

let og = canvas(width: 1200, height: 630) {
  roundedBackground(NSRect(x: 0, y: 0, width: 1200, height: 630), radius: 0)
  drawBell(in: NSRect(x: 96, y: 126, width: 354, height: 354))
  text("DONNA / SUBSCRIPTION ALERT", at: NSPoint(x: 520, y: 459), size: 18, weight: .semibold, color: gold)
  text("해외 AI·SaaS 구독", at: NSPoint(x: 520, y: 339), size: 50, weight: .bold, color: cream)
  text("결제 전에 알려드립니다", at: NSPoint(x: 520, y: 267), size: 50, weight: .bold, color: cream)
  text("donna.co.kr", at: NSPoint(x: 523, y: 182), size: 24, weight: .medium, color: muted)
}
try save(og, name: "og-donna-1200x630.png")

let promoSmall = canvas(width: 440, height: 280) {
  roundedBackground(NSRect(x: 0, y: 0, width: 440, height: 280), radius: 0)
  drawBell(in: NSRect(x: 122, y: 42, width: 196, height: 196))
}
try save(promoSmall, name: "promo-small-440x280.png")

let promoWide = canvas(width: 1400, height: 560) {
  roundedBackground(NSRect(x: 0, y: 0, width: 1400, height: 560), radius: 0)
  drawBell(in: NSRect(x: 92, y: 70, width: 420, height: 420))
  text("DONNA.CO.KR", at: NSPoint(x: 590, y: 395), size: 20, weight: .semibold, color: gold)
  text("돈나가요", at: NSPoint(x: 590, y: 286), size: 70, weight: .bold, color: cream)
  text("해외 AI·SaaS 구독 결제 전 알림", at: NSPoint(x: 594, y: 220), size: 28, weight: .medium, color: muted)
}
try save(promoWide, name: "promo-marquee-1400x560.png")

func storeBase(kicker: String, line1: String, line2: String, detail: String, panel: () -> Void) -> NSImage {
  canvas(width: 1280, height: 800) {
    roundedBackground(NSRect(x:0,y:0,width:1280,height:800), radius:0)
    drawBell(in:NSRect(x:78,y:588,width:110,height:110))
    text(kicker, at:NSPoint(x:82,y:548), size:20, weight:.semibold, color:gold)
    text(line1, at:NSPoint(x:80,y:420), size:52, weight:.bold, color:cream)
    text(line2, at:NSPoint(x:80,y:350), size:52, weight:.bold, color:cream)
    text(detail, at:NSPoint(x:84,y:278), size:21, weight:.medium, color:muted)
    panel()
  }
}

let shot1 = storeBase(kicker:"결제 전에 알려드립니다", line1:"잊고 있던 구독도", line2:"빠져나가기 전에", detail:"결제일과 금액을 확인하고 계속 쓸지 결정하세요") {
  roundRect(NSRect(x:700,y:88,width:490,height:624), radius:30, fill:color(0xFBF8F0))
  roundRect(NSRect(x:730,y:610,width:430,height:72), radius:18, fill:forest)
  text("돈나가요", at:NSPoint(x:754,y:636), size:20, weight:.bold, color:cream)
  text("4일 뒤 결제 예정", at:NSPoint(x:748,y:552), size:18, weight:.semibold, color:forest)
  text("Higgsfield", at:NSPoint(x:748,y:472), size:31, weight:.bold, color:color(0x10271F))
  text("₩682,813 · 연 구독", at:NSPoint(x:748,y:432), size:20, weight:.medium, color:color(0x61766D))
  roundRect(NSRect(x:748,y:336,width:190,height:58), radius:14, fill:forest)
  text("결제 설정 열기", at:NSPoint(x:776,y:353), size:18, weight:.semibold, color:cream)
  text("알림은 이 브라우저에 저장됩니다", at:NSPoint(x:748,y:188), size:17, weight:.medium, color:color(0x809188))
}
try save(shot1, name:"store-screenshot-01-1280x800.png")

let shot2 = storeBase(kicker:"구독 알림", line1:"다가오는 결제를", line2:"한눈에 확인", detail:"월 구독과 연 구독의 다음 결제일을 모아봅니다") {
  roundRect(NSRect(x:700,y:88,width:490,height:624), radius:30, fill:color(0xFBF8F0))
  text("다음 결제 2건", at:NSPoint(x:742,y:644), size:22, weight:.bold, color:forest)
  for (y,name,date,amount) in [(452,"Higgsfield","9월 5일 · 4일 남음","₩682,813 · 연"),(258,"ChatGPT Plus","9월 21일 · 20일 남음","USD 20 · 월")] {
    roundRect(NSRect(x:730,y:y,width:430,height:166), radius:20, fill:color(0xFFFCF5), stroke:color(0xDCE4DE))
    text(name, at:NSPoint(x:754,y:y+108), size:23, weight:.bold, color:color(0x10271F))
    text(amount, at:NSPoint(x:754,y:y+72), size:17, weight:.medium, color:color(0x61766D))
    text(date, at:NSPoint(x:754,y:y+34), size:17, weight:.semibold, color:forest)
  }
}
try save(shot2, name:"store-screenshot-02-1280x800.png")

let shot3 = storeBase(kicker:"사업자용 정리", line1:"부가세와 결제 기록도", line2:"함께 정리", detail:"Tax ID 입력 위치와 분기 자료 내보내기를 돕습니다") {
  roundRect(NSRect(x:700,y:88,width:490,height:624), radius:30, fill:color(0xFBF8F0))
  text("결제 기록 · 세무", at:NSPoint(x:742,y:644), size:22, weight:.bold, color:forest)
  roundRect(NSRect(x:730,y:458,width:430,height:138), radius:20, fill:forest)
  text("이번 분기 해외 결제", at:NSPoint(x:754,y:548), size:16, weight:.semibold, color:muted)
  text("₩1,284,600", at:NSPoint(x:754,y:492), size:35, weight:.bold, color:cream)
  text("Tax ID 확인", at:NSPoint(x:742,y:388), size:18, weight:.bold, color:color(0x10271F))
  text("서비스별 입력 위치를 바로 확인합니다", at:NSPoint(x:742,y:350), size:17, weight:.medium, color:color(0x61766D))
  roundRect(NSRect(x:742,y:222,width:260,height:62), radius:14, fill:forest)
  text("분기 자료 내보내기", at:NSPoint(x:772,y:241), size:18, weight:.semibold, color:cream)
}
try save(shot3, name:"store-screenshot-03-1280x800.png")

print("Donna brand assets generated")
