//! The app's switch: the kit's switch behaviour, drawn so that its off position can be seen.
//!
//! The kit's `Switch` paints its off track in the theme's `switch` colour, and its knob, in both
//! positions, in `switch.thumb`. The macOS Classic theme set neither, so they fell back to a
//! translucent grey and to the window's own background, and on the dark theme a switch that was
//! off was three shades of the panel's grey: the track, the knob and the panel could not be told
//! apart. The theme now names both (`themes/macos-classic.json`), and every switch in the app is
//! this one, because one knob colour cannot do both jobs: bright against the dark theme's off
//! track, it would vanish against its on track, which is the theme's white primary. So the knob is
//! drawn per position here, and the off track carries a ring, so the switch's outline reads on
//! any panel in either theme.
//!
//! Pointer, keyboard and accessibility are the kit's own base switch, untouched.

use std::rc::Rc;

use gpui_kit::base::{Switch as BaseSwitch, SwitchThumb, SwitchTrack, spring};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme, Theme};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

/// What a switch is drawn in, from the theme's tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SwitchColors {
    pub track: Hsla,
    /// The 1px edge of the track. Off, it is the outline that lets the switch be seen on a panel
    /// close to its own grey; on, the fill says enough and the edge is clear.
    pub ring: Hsla,
    pub knob: Hsla,
}

impl SwitchColors {
    pub(crate) fn of(theme: &Theme, checked: bool) -> Self {
        if checked {
            // The theme's primary fill and the colour it writes on that fill, so the knob shows
            // on it whatever the primary is: white on black in the light theme, and black on
            // white in the dark one, as the switch has always looked when on.
            Self {
                track: theme.primary,
                ring: gpui_kit::transparent_black(),
                knob: theme.primary_foreground,
            }
        } else {
            Self {
                track: theme.switch,
                ring: theme.muted_foreground.opacity(0.6),
                knob: theme.switch_thumb,
            }
        }
    }
}

type ChangeHandler = Rc<dyn Fn(&bool, &mut Window, &mut App)>;

/// A switch, controlled: the owner renders the value a click asks for back through `checked`.
#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    checked: bool,
    disabled: bool,
    small: bool,
    label: Option<SharedString>,
    accessibility_label: Option<SharedString>,
    tooltip: Option<SharedString>,
    on_click: Option<ChangeHandler>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            checked: false,
            disabled: false,
            small: false,
            label: None,
            accessibility_label: None,
            tooltip: None,
            on_click: None,
        }
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    /// Dead to the pointer and the keyboard, and drawn faded.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The kit's small size: a 28×16 track and a smaller label.
    pub fn small(mut self) -> Self {
        self.small = true;
        self
    }

    /// The words beside it, which are also the name a screen reader announces.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The name a screen reader announces, when the switch has no label or the label is not it.
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Called with the value a click or a key asks for. Never while disabled.
    pub fn on_click(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let checked = self.checked;
        let disabled = self.disabled;
        let theme = cx.theme();
        let colors = SwitchColors::of(theme, checked);
        let muted = theme.muted_foreground;
        let motion = theme.motion_tokens().spring_move;
        let (track_w, track_h, knob) = if self.small {
            (px(28.), px(16.), px(12.))
        } else {
            (px(36.), px(20.), px(16.))
        };
        // The knob sits 2px inside the track's edge: the 1px ring and 1px of padding.
        let inset = px(2.);
        // A disabled switch fades its track alone. GPUI's opacity multiplies each primitive
        // rather than the group, so fading the whole control would show the track through the
        // knob.
        let fade = |color: Hsla| if disabled { color.opacity(0.5) } else { color };
        let knob_x = spring(
            (self.id.clone(), "thumb"),
            if checked {
                track_w - knob - inset * 2
            } else {
                px(0.)
            },
            motion,
            window,
            cx,
        );
        let accessibility_label = self.accessibility_label.or_else(|| self.label.clone());

        BaseSwitch::new(self.id.clone())
            .checked(checked)
            .disabled(disabled)
            .when_some(accessibility_label, |this, label| {
                this.accessibility_label(label)
            })
            .when_some(self.on_click, |this, on_click| {
                this.on_change(move |next, _, window, cx| on_click(&next, window, cx))
            })
            .flex()
            .flex_row()
            .gap_2()
            .items_start()
            .when(disabled, |this| this.text_color(muted).cursor_not_allowed())
            .child(
                SwitchTrack::new((self.id.clone(), "track"))
                    .checked(checked)
                    .disabled(disabled)
                    .flex_shrink_0()
                    .w(track_w)
                    .h(track_h)
                    .rounded(track_h)
                    .flex()
                    .items_center()
                    .p(px(1.))
                    .border_1()
                    .border_color(fade(colors.ring))
                    .bg(fade(colors.track))
                    .when_some(self.tooltip, |this, tooltip| {
                        this.tooltip(move |window, cx| {
                            Tooltip::new(tooltip.clone()).build(window, cx)
                        })
                    })
                    .child(
                        SwitchThumb::new(checked)
                            .rounded(knob)
                            .size(knob)
                            .left(knob_x)
                            .bg(colors.knob),
                    ),
            )
            .when_some(self.label, |this, label| {
                this.child(
                    div()
                        .line_height(track_h)
                        .map(|this| {
                            if self.small {
                                this.text_sm()
                            } else {
                                this.text_base()
                            }
                        })
                        .child(label),
                )
            })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::SwitchColors;
    use gpui_kit::component::{Theme, ThemeSet};
    use gpui_kit::{Hsla, Rgba};
    use std::rc::Rc;

    /// The relative luminance WCAG measures contrast by.
    fn luminance(color: Hsla) -> f32 {
        let rgba = Rgba::from(color);
        let linear = |c: f32| {
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(rgba.r) + 0.7152 * linear(rgba.g) + 0.0722 * linear(rgba.b)
    }

    /// How far apart two opaque colours are to the eye, from 1 (the same) to 21.
    pub(crate) fn contrast(a: Hsla, b: Hsla) -> f32 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// The app's two themes, as they are shipped.
    pub(crate) fn macos_classic() -> Vec<Theme> {
        let set: ThemeSet =
            serde_json::from_str(include_str!("../../themes/macos-classic.json")).unwrap();
        assert_eq!(set.themes.len(), 2, "a light and a dark theme");
        set.themes
            .into_iter()
            .map(|config| {
                let mut theme = Theme::default();
                theme.apply_config(&Rc::new(config));
                theme
            })
            .collect()
    }

    /// A switch that is off has to be seen on the panel it sits on, in both themes: its track
    /// apart from the panel, its outline more so, and its knob bright against its track. The dark
    /// theme's off switch was a translucent grey track and a knob the colour of the window's
    /// background, on a panel of the same grey. And on, the knob still shows on its fill.
    #[test]
    fn an_off_switch_can_be_seen_on_its_panel_in_both_themes() {
        for theme in macos_classic() {
            let mode = if theme.is_dark() { "dark" } else { "light" };
            let panel = theme.sidebar;
            // The theme's own tokens first: these are what every switch is drawn from.
            let track = panel.blend(theme.switch);
            assert!(
                contrast(track, panel) >= 1.5,
                "{mode}: the off track is the panel's grey ({:.2})",
                contrast(track, panel)
            );
            let knob = track.blend(theme.switch_thumb);
            assert!(
                luminance(knob) > luminance(track) && contrast(knob, track) >= 1.8,
                "{mode}: the off knob is not bright on its track ({:.2})",
                contrast(knob, track)
            );

            let off = SwitchColors::of(&theme, false);
            let ring = track.blend(off.ring);
            assert!(
                contrast(ring, panel) >= 3.0,
                "{mode}: the off track has no outline to see ({:.2})",
                contrast(ring, panel)
            );
            let on = SwitchColors::of(&theme, true);
            assert!(
                contrast(on.knob, on.track) >= 4.5,
                "{mode}: the on knob is lost on its fill ({:.2})",
                contrast(on.knob, on.track)
            );
        }
    }

    /// Every switch in the app is this one, so an off switch reads the same everywhere. The
    /// Mac relay's card once drew the kit's own switch, whose knob vanished on the light
    /// track, and sat beside "Show turn timing" looking like a different control.
    #[test]
    fn no_component_draws_the_kits_switch_directly() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/components");
        let mut stack = vec![dir];
        let mut offenders = Vec::new();
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("components dir") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && !path.ends_with("switch.rs")
                {
                    let text = std::fs::read_to_string(&path).expect("source");
                    if text.contains("gpui_kit::component::switch::Switch") {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "draw crate::components::switch::Switch instead: {offenders:?}"
        );
    }
}
