import SwiftUI

/// s29: the secure field for the Claude API key and the line under it. The typed text lives only in the flow (memory)
/// and is cleared when it is handed to the check. Snapshots draw a placeholder (offscreen rendering cannot draw a live
/// field) and never any key.
struct ClaudeKeyField: View {
  @ObservedObject var model: ClaudeKeyModel
  var onSubmit: () -> Void
  @FocusState private var focused: Bool
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isSnapshot) private var isSnapshot

  var body: some View {
    let p = Palette(scheme: scheme)
    let shape = RoundedRectangle(cornerRadius: Tokens.Radius.row, style: .continuous)
    VStack(alignment: .leading, spacing: Tokens.Space.s8) {
      Group {
        if isSnapshot {
          Text(ClaudeKeyStep.placeholder).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          SecureField(ClaudeKeyStep.placeholder, text: Binding(get: { model.flow.text }, set: { model.edit($0) }))
            .textFieldStyle(.plain)
            .textStyle(Tokens.TypeScale.body)
            .foregroundStyle(p.ink1)
            .focused($focused)
            .disabled(model.flow.isChecking)
            .onSubmit(onSubmit)
            .accessibilityLabel(ClaudeKeyStep.title)
        }
      }
      .padding(.horizontal, Tokens.Space.s12)
      .frame(height: Tokens.Size.row)
      .background(shape.fill(p.fill))
      .overlay(shape.strokeBorder(focused ? p.ringStrong : p.ring, lineWidth: Tokens.Layout.hairline))
      if let m = model.flow.message {
        Text(m).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      if model.flow.canSaveWithoutChecking {
        SecondaryButton(title: ClaudeKeyStep.saveAnywayTitle) { model.saveWithoutChecking() }
      }
    }
    .onAppear { if !isSnapshot { focused = true } }
  }
}

/// The first-run window's key screen body (its buttons are the window's own: Skip for now, Save key).
struct ClaudeKeyStepView: View {
  @ObservedObject var model: ClaudeKeyModel
  var onSubmit: () -> Void
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Tokens.Space.s16) {
      Text(ClaudeKeyStep.intro).paragraphStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
        .fixedSize(horizontal: false, vertical: true)
      ClaudeKeyField(model: model, onSubmit: onSubmit)
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.s8) {
        Image(systemName: "lock").symbolStyle(Tokens.TypeScale.Symbol.small).foregroundStyle(p.ink3)
          .frame(width: Tokens.Space.s12)
        Text(ClaudeKeyStep.helper).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

/// The dashboard's Settings row: "Key set (…ABCD)" with Replace key and Remove key, or "No key yet" with Add key.
struct ClaudeKeySettingsSection: View {
  @ObservedObject var model: ClaudeKeyModel
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let p = Palette(scheme: scheme)
    WindowSection(title: "Settings") {
      RingBox {
        VStack(alignment: .leading, spacing: Tokens.Space.s12) {
          HStack(spacing: Tokens.Space.s8) {
            Text("Claude API key").textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink2)
              .frame(width: Tokens.Layout.labelColumn, alignment: .leading)
            Text(model.status.settingsLine).textStyle(Tokens.TypeScale.body).foregroundStyle(p.ink1)
            Spacer()
            if !model.flow.isEntering {
              ForEach(model.flow.actions, id: \.title) { a in
                SecondaryButton(title: a.title) {
                  switch a {
                  case .add, .replace: model.beginReplace()
                  case .remove: model.remove()
                  }
                }
              }
            }
          }
          if model.flow.isEntering {
            ClaudeKeyField(model: model) { Task { await model.submit() } }
            HStack(spacing: Tokens.Space.s8) {
              Spacer()
              SecondaryButton(title: "Cancel") { model.cancel() }
              PrimaryButton(title: model.flow.isChecking ? "Checking…" : ClaudeKeyStep.saveTitle) {
                Task { await model.submit() }
              }
              .disabled(model.flow.isChecking)
            }
          } else if case .failed(let m) = model.flow.phase {
            Text(m).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink2)
          }
          if !model.status.isSet {
            Text(ClaudeKeyStep.intro).paragraphStyle(Tokens.TypeScale.callout).foregroundStyle(p.ink3)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.horizontal, Tokens.Space.s16).padding(.vertical, Tokens.Space.s12)
      }
    }
  }
}
