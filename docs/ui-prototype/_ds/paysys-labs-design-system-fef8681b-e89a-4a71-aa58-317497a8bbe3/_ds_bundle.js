/* @ds-bundle: {"format":4,"namespace":"PaysysLabsDesignSystem_fef868","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"ProcessSteps","sourcePath":"components/data/ProcessSteps.jsx"},{"name":"StatMetric","sourcePath":"components/data/StatMetric.jsx"},{"name":"FlowDiagram","sourcePath":"components/diagrams/FlowDiagram.jsx"},{"name":"Alert","sourcePath":"components/feedback/Alert.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"Dialog","sourcePath":"components/overlays/Dialog.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"90d61d45759f","components/core/Button.jsx":"5d33299a2eeb","components/core/Card.jsx":"8a10865fc145","components/core/IconButton.jsx":"da207c528e10","components/core/Tag.jsx":"71e8651cbf8c","components/data/ProcessSteps.jsx":"1de8fa4ba6d0","components/data/StatMetric.jsx":"b038d22cc5a2","components/diagrams/FlowDiagram.jsx":"65fd6fb8ceb8","components/feedback/Alert.jsx":"52e8df726dfd","components/feedback/Toast.jsx":"ceb3defc5e52","components/feedback/Tooltip.jsx":"c7ab89b8ddef","components/forms/Checkbox.jsx":"c9faa7139297","components/forms/Input.jsx":"b75c70e96c25","components/forms/Radio.jsx":"054415deec45","components/forms/Select.jsx":"a874eb8452f8","components/forms/Switch.jsx":"d0bb59c72866","components/navigation/Tabs.jsx":"31c1e7d6c66a","components/overlays/Dialog.jsx":"b02d5179ee7a"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.PaysysLabsDesignSystem_fef868 = window.PaysysLabsDesignSystem_fef868 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
const TONES = {
  neutral: {
    bg: 'var(--slate-100)',
    color: 'var(--slate-700)',
    dot: 'var(--slate-500)'
  },
  brand: {
    bg: 'var(--blue-50)',
    color: 'var(--blue-700)',
    dot: 'var(--blue-600)'
  },
  success: {
    bg: 'var(--success-100)',
    color: '#155c3f',
    dot: 'var(--success-600)'
  },
  warning: {
    bg: 'var(--warning-100)',
    color: '#7a4a0e',
    dot: 'var(--warning-600)'
  },
  danger: {
    bg: 'var(--danger-100)',
    color: '#832721',
    dot: 'var(--danger-600)'
  },
  info: {
    bg: 'var(--info-100)',
    color: 'var(--blue-700)',
    dot: 'var(--info-600)'
  }
};
function Badge({
  tone = 'neutral',
  dot = false,
  children
}) {
  const t = TONES[tone] || TONES.neutral;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 10px',
      borderRadius: 'var(--radius-pill)',
      background: t.bg,
      color: t.color,
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-caption)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: 'var(--tracking-wide)',
      textTransform: 'uppercase',
      lineHeight: 1.6
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: t.dot,
      flexShrink: 0
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
const SIZES = {
  sm: {
    padding: '6px 12px',
    fontSize: 'var(--fs-body-sm)',
    gap: 6,
    radius: 'var(--radius-sm)'
  },
  md: {
    padding: '10px 18px',
    fontSize: 'var(--fs-body-md)',
    gap: 8,
    radius: 'var(--radius-md)'
  },
  lg: {
    padding: '13px 24px',
    fontSize: 'var(--fs-body-lg)',
    gap: 10,
    radius: 'var(--radius-md)'
  }
};
const VARIANTS = {
  primary: {
    bg: 'var(--blue-600)',
    hoverBg: 'var(--blue-700)',
    color: 'var(--white)',
    border: 'var(--blue-600)'
  },
  secondary: {
    bg: 'var(--slate-100)',
    hoverBg: 'var(--slate-200)',
    color: 'var(--color-text-primary)',
    border: 'var(--slate-100)'
  },
  outline: {
    bg: 'transparent',
    hoverBg: 'var(--blue-50)',
    color: 'var(--blue-600)',
    border: 'var(--blue-600)'
  },
  ghost: {
    bg: 'transparent',
    hoverBg: 'var(--blue-50)',
    color: 'var(--blue-600)',
    border: 'transparent'
  },
  danger: {
    bg: 'var(--danger-600)',
    hoverBg: '#a12a22',
    color: 'var(--white)',
    border: 'var(--danger-600)'
  }
};
function Button(props) {
  const {
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    icon = null,
    iconPosition = 'left',
    fullWidth = false,
    children,
    onClick,
    type = 'button'
  } = props;
  const [hover, setHover] = React.useState(false);
  const v = VARIANTS[variant] || VARIANTS.primary;
  const s = SIZES[size] || SIZES.md;
  const isDisabled = disabled || loading;
  const style = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    padding: s.padding,
    fontSize: s.fontSize,
    fontFamily: 'var(--font-body)',
    fontWeight: 'var(--weight-semibold)',
    borderRadius: s.radius,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    width: fullWidth ? '100%' : 'auto',
    background: hover && !isDisabled ? v.hoverBg : v.bg,
    color: v.color,
    border: `1.5px solid ${v.border}`,
    transition: 'background var(--duration-fast) var(--ease-standard)',
    boxSizing: 'border-box'
  };
  return /*#__PURE__*/React.createElement("button", {
    type: type,
    disabled: isDisabled,
    onClick: onClick,
    style: style,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, loading ? /*#__PURE__*/React.createElement(Spinner, null) : icon && iconPosition === 'left' ? /*#__PURE__*/React.createElement(IconSlot, null, icon) : null, children && /*#__PURE__*/React.createElement("span", null, children), !loading && icon && iconPosition === 'right' ? /*#__PURE__*/React.createElement(IconSlot, null, icon) : null);
}
function IconSlot({
  children
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      width: 16,
      height: 16
    }
  }, children);
}
function Spinner() {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.45)',
      borderTopColor: 'currentColor',
      display: 'inline-block',
      animation: 'paysys-spin 0.7s linear infinite'
    }
  });
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
const HEADER_TONES = {
  blue: 'linear-gradient(135deg, var(--blue-600), var(--blue-700))',
  navy: 'linear-gradient(135deg, var(--navy-800), var(--navy-900))',
  sky: 'linear-gradient(135deg, var(--sky-500), var(--blue-600))'
};
function Card(props) {
  const {
    eyebrow,
    title,
    headerTone,
    children,
    footer,
    padded = true
  } = props;
  const hasHeader = Boolean(title) && Boolean(headerTone);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--color-border)',
      background: 'var(--color-surface)',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column'
    }
  }, hasHeader && /*#__PURE__*/React.createElement("div", {
    style: {
      background: HEADER_TONES[headerTone] || HEADER_TONES.blue,
      color: 'var(--white)',
      padding: '14px 20px',
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--fs-h4)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: padded ? '20px' : 0,
      flex: 1
    }
  }, !hasHeader && title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--fs-h4)',
      color: 'var(--color-text-primary)',
      marginBottom: 6
    }
  }, title), eyebrow && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-overline)',
      letterSpacing: 'var(--tracking-overline)',
      textTransform: 'uppercase',
      color: 'var(--blue-600)',
      fontWeight: 'var(--weight-semibold)',
      marginBottom: 8
    }
  }, eyebrow), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-body-md)',
      color: 'var(--color-text-secondary)',
      lineHeight: 'var(--lh-body-md)'
    }
  }, children)), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 20px',
      borderTop: '1px solid var(--color-border)',
      background: 'var(--color-bg-subtle)'
    }
  }, footer));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
const SIZES = {
  sm: 28,
  md: 36,
  lg: 44
};
const VARIANTS = {
  primary: {
    bg: 'var(--blue-600)',
    hoverBg: 'var(--blue-700)',
    color: 'var(--white)',
    border: 'var(--blue-600)'
  },
  outline: {
    bg: 'transparent',
    hoverBg: 'var(--blue-50)',
    color: 'var(--blue-600)',
    border: 'var(--slate-200)'
  },
  ghost: {
    bg: 'transparent',
    hoverBg: 'var(--slate-100)',
    color: 'var(--color-text-secondary)',
    border: 'transparent'
  }
};
function IconButton(props) {
  const {
    icon,
    variant = 'ghost',
    size = 'md',
    disabled = false,
    onClick,
    'aria-label': ariaLabel
  } = props;
  const [hover, setHover] = React.useState(false);
  const v = VARIANTS[variant] || VARIANTS.ghost;
  const d = SIZES[size] || SIZES.md;
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": ariaLabel,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: d,
      height: d,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 'var(--radius-md)',
      border: `1.5px solid ${v.border}`,
      background: hover && !disabled ? v.hoverBg : v.bg,
      color: v.color,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background var(--duration-fast) var(--ease-standard)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: size === 'lg' ? 20 : 16,
      height: size === 'lg' ? 20 : 16,
      display: 'inline-flex'
    }
  }, icon));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function Tag({
  children,
  onRemove,
  variant = 'default'
}) {
  const outlined = variant === 'outline';
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 10px 5px 12px',
      borderRadius: 'var(--radius-sm)',
      background: outlined ? 'transparent' : 'var(--slate-50)',
      border: `1px solid ${outlined ? 'var(--slate-300)' : 'var(--slate-100)'}`,
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-body-sm)',
      color: 'var(--color-text-secondary)',
      lineHeight: 1.6
    }
  }, children, onRemove && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onRemove,
    "aria-label": "Remove",
    style: {
      border: 'none',
      background: 'none',
      cursor: 'pointer',
      padding: 2,
      lineHeight: 0,
      color: 'var(--slate-500)',
      fontSize: 14,
      display: 'inline-flex'
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/data/ProcessSteps.jsx
try { (() => {
function ProcessSteps({
  steps = [],
  activeIndex
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      width: '100%',
      fontFamily: 'var(--font-body)'
    }
  }, steps.map((step, i) => {
    const label = typeof step === 'string' ? step : step.label;
    const isActive = activeIndex === i;
    const isDone = activeIndex !== undefined && i < activeIndex;
    const nodeColor = isActive || isDone ? 'var(--blue-600)' : 'var(--slate-200)';
    const textColor = isActive ? 'var(--blue-600)' : 'var(--color-text-secondary)';
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: i
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        minWidth: 64
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: nodeColor,
        color: isActive || isDone ? 'var(--white)' : 'var(--slate-500)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 'var(--weight-bold)',
        fontSize: 'var(--fs-body-sm)',
        flexShrink: 0
      }
    }, i + 1), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--fs-caption)',
        fontWeight: 'var(--weight-semibold)',
        color: textColor,
        textAlign: 'center',
        whiteSpace: 'nowrap'
      }
    }, label)), i < steps.length - 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        height: 2,
        background: isDone ? 'var(--blue-600)' : 'var(--slate-200)',
        marginTop: 17
      }
    }));
  }));
}
Object.assign(__ds_scope, { ProcessSteps });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/ProcessSteps.jsx", error: String((e && e.message) || e) }); }

// components/data/StatMetric.jsx
try { (() => {
function StatMetric({
  value,
  label,
  tone = 'blue',
  trend
}) {
  const color = tone === 'gold' ? 'var(--gold-600)' : tone === 'navy' ? 'var(--navy-900)' : 'var(--blue-600)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-extrabold)',
      fontSize: 'var(--fs-display-lg)',
      color,
      lineHeight: 1
    }
  }, value), trend && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-caption)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--success-600)'
    }
  }, trend)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-body-sm)',
      color: 'var(--color-text-secondary)'
    }
  }, label));
}
Object.assign(__ds_scope, { StatMetric });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/StatMetric.jsx", error: String((e && e.message) || e) }); }

// components/diagrams/FlowDiagram.jsx
try { (() => {
const DEFAULT_LANES = [{
  bg: 'var(--lane-1)',
  text: 'var(--lane-1-text)'
}, {
  bg: 'var(--lane-2)',
  text: 'var(--lane-2-text)'
}, {
  bg: 'var(--lane-3)',
  text: 'var(--lane-3-text)'
}, {
  bg: 'var(--lane-4)',
  text: 'var(--lane-4-text)'
}, {
  bg: 'var(--lane-5)',
  text: 'var(--lane-5-text)'
}, {
  bg: 'var(--lane-6)',
  text: 'var(--lane-6-text)'
}];
const PHASE_TONES = {
  slate: 'var(--navy-900)',
  blue: 'var(--blue-700)'
};
const SINGLE_H = 44,
  PAIR_H = 74,
  LOOP_H = 74,
  GUTTER = 34;
function stepHeight(s) {
  return s.self ? LOOP_H : s.reply ? PAIR_H : SINGLE_H;
}
function FlowDiagram({
  actors = [],
  steps = [],
  phases = [],
  activations = []
}) {
  const lanes = actors.map((a, i) => typeof a === 'string' ? {
    id: a,
    label: a
  } : a);
  const n = lanes.length;
  const colored = lanes.map((a, i) => ({
    ...a,
    bg: a.color || DEFAULT_LANES[i % DEFAULT_LANES.length].bg,
    text: a.textColor || DEFAULT_LANES[i % DEFAULT_LANES.length].text
  }));
  const findIdx = ref => typeof ref === 'number' ? ref : colored.findIndex(a => a.id === ref);
  const colX = i => (i + 0.5) / n * 100;
  let acc = 0;
  const tops = steps.map(s => {
    const t = acc;
    acc += stepHeight(s);
    return t;
  });
  const totalH = acc + 10;
  const gutter = phases.length ? GUTTER : 0;
  const rangeY = (from, to) => [tops[from - 1] ?? 0, to >= steps.length ? totalH : tops[to]];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      marginLeft: gutter
    }
  }, colored.map((a, i) => /*#__PURE__*/React.createElement("div", {
    key: a.id,
    style: {
      flex: 1,
      padding: '0 4px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: a.bg,
      color: a.text,
      textAlign: 'center',
      padding: '10px 6px',
      borderRadius: 'var(--radius-sm)',
      fontWeight: 'var(--weight-bold)',
      fontSize: 13,
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-wide)',
      border: '1.5px solid rgba(10,37,64,0.15)'
    }
  }, a.label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: totalH,
      marginTop: 6,
      marginLeft: gutter
    }
  }, phases.map((p, pi) => {
    const [y1, y2] = rangeY(p.from, p.to);
    return /*#__PURE__*/React.createElement("div", {
      key: pi,
      style: {
        position: 'absolute',
        left: -gutter,
        top: y1,
        width: gutter - 6,
        height: y2 - y1,
        background: PHASE_TONES[p.tone] || p.tone || PHASE_TONES.slate,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--white)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '.02em',
        transform: 'rotate(-90deg)',
        whiteSpace: 'nowrap'
      }
    }, p.label));
  }), colored.map((a, i) => /*#__PURE__*/React.createElement("div", {
    key: a.id,
    style: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: `${colX(i)}%`,
      borderLeft: '1.5px dashed var(--slate-300)'
    }
  })), activations.map((act, ai) => {
    const li = findIdx(act.actor);
    const ac = colored[li];
    const [y1, y2] = rangeY(act.from, act.to);
    if (!ac) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: ai,
      style: {
        position: 'absolute',
        left: `${colX(li)}%`,
        transform: 'translateX(-50%)',
        top: y1 + 20,
        width: 13,
        height: Math.max(y2 - y1 - 14, 10),
        background: ac.bg,
        border: '1px solid rgba(10,37,64,0.25)',
        borderRadius: 3,
        zIndex: 1
      }
    });
  }), /*#__PURE__*/React.createElement("svg", {
    width: "100%",
    height: totalH,
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      overflow: 'visible',
      zIndex: 2
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("marker", {
    id: "fd-arrow",
    viewBox: "0 0 10 10",
    refX: "8",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M0,0 L10,5 L0,10 z",
    style: {
      fill: 'var(--diagram-line)'
    }
  }))), steps.map((s, i) => {
    const top = tops[i];
    const iFrom = findIdx(s.from),
      iTo = findIdx(s.to);
    if (s.self) {
      const dir = iFrom >= n - 1 ? -1 : 1;
      const x1 = colX(iFrom),
        x2 = x1 + dir * 6.5;
      const y1 = top + 16,
        y2 = top + 54;
      return /*#__PURE__*/React.createElement("path", {
        key: i,
        d: `M ${x1}% ${y1} H ${x2}% V ${y2} H ${x1}%`,
        fill: "none",
        style: {
          stroke: 'var(--diagram-line)',
          strokeWidth: 2
        },
        markerEnd: "url(#fd-arrow)"
      });
    }
    const x1 = colX(iFrom),
      x2 = colX(iTo);
    const solidY = top + (s.reply ? 28 : 24);
    return /*#__PURE__*/React.createElement("g", {
      key: i
    }, /*#__PURE__*/React.createElement("line", {
      x1: `${x1}%`,
      y1: solidY,
      x2: `${x2}%`,
      y2: solidY,
      style: {
        stroke: 'var(--diagram-line)',
        strokeWidth: 2
      },
      markerEnd: "url(#fd-arrow)"
    }), s.reply && /*#__PURE__*/React.createElement("line", {
      x1: `${x2}%`,
      y1: solidY + 28,
      x2: `${x1}%`,
      y2: solidY + 28,
      style: {
        stroke: 'var(--diagram-line)',
        strokeWidth: 1.5,
        strokeDasharray: '5,4'
      },
      markerEnd: "url(#fd-arrow)"
    }));
  })), steps.map((s, i) => {
    const top = tops[i];
    const iFrom = findIdx(s.from),
      iTo = findIdx(s.to);
    const prefix = s.number == null ? null : s.number === 'info' ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--slate-500)',
        fontWeight: 600
      }
    }, "(info) ") : /*#__PURE__*/React.createElement("b", {
      style: {
        color: 'var(--blue-700)'
      }
    }, "(", s.number, ") ");
    if (s.self) {
      const dir = iFrom >= n - 1 ? -1 : 1;
      return /*#__PURE__*/React.createElement("div", {
        key: i,
        style: {
          position: 'absolute',
          top: top + 8,
          zIndex: 3,
          textAlign: dir > 0 ? 'left' : 'right',
          width: '30%',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--slate-900)',
          lineHeight: 1.35,
          ...(dir > 0 ? {
            left: `${colX(iFrom) + 7}%`
          } : {
            right: `${100 - colX(iFrom) + 7}%`
          })
        }
      }, prefix, s.label);
    }
    const mid = (colX(iFrom) + colX(iTo)) / 2;
    const span = Math.max(Math.abs(colX(iTo) - colX(iFrom)), 100 / n) * 0.92;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        position: 'absolute',
        top: top + 2,
        left: `${mid}%`,
        transform: 'translateX(-50%)',
        textAlign: 'center',
        width: `${span}%`,
        zIndex: 3
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--slate-900)',
        lineHeight: 1.3
      }
    }, prefix, s.label), s.reply && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10.5,
        fontWeight: 500,
        color: 'var(--slate-500)',
        marginTop: 30
      }
    }, s.reply));
  })));
}
Object.assign(__ds_scope, { FlowDiagram });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/diagrams/FlowDiagram.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Alert.jsx
try { (() => {
const TONES = {
  info: {
    bg: 'var(--info-100)',
    border: 'var(--blue-400)',
    color: '#0d3f5e',
    icon: 'i'
  },
  success: {
    bg: 'var(--success-100)',
    border: 'var(--success-600)',
    color: '#155c3f',
    icon: '✓'
  },
  warning: {
    bg: 'var(--warning-100)',
    border: 'var(--warning-600)',
    color: '#7a4a0e',
    icon: '!'
  },
  danger: {
    bg: 'var(--danger-100)',
    border: 'var(--danger-600)',
    color: '#832721',
    icon: '✕'
  }
};
function Alert({
  tone = 'info',
  title,
  children,
  onDismiss
}) {
  const t = TONES[tone] || TONES.info;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      padding: '14px 16px',
      borderRadius: 'var(--radius-md)',
      background: t.bg,
      border: `1px solid ${t.border}`,
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flexShrink: 0,
      width: 22,
      height: 22,
      borderRadius: '50%',
      background: t.border,
      color: 'var(--white)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12,
      fontWeight: 'var(--weight-bold)'
    }
  }, t.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      color: t.color
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--fs-body-md)',
      marginBottom: children ? 2 : 0
    }
  }, title), children && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--fs-body-sm)',
      lineHeight: 'var(--lh-body-sm)'
    }
  }, children)), onDismiss && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onDismiss,
    "aria-label": "Dismiss",
    style: {
      border: 'none',
      background: 'none',
      cursor: 'pointer',
      color: t.color,
      opacity: 0.6,
      fontSize: 16,
      lineHeight: 1,
      flexShrink: 0
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Alert });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Alert.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
const TONES = {
  info: 'var(--blue-600)',
  success: 'var(--success-600)',
  warning: 'var(--warning-600)',
  danger: 'var(--danger-600)'
};
function Toast({
  tone = 'info',
  title,
  message,
  onClose
}) {
  const accent = TONES[tone] || TONES.info;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      width: 340,
      padding: '14px 16px',
      background: 'var(--white)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      borderLeft: `4px solid ${accent}`,
      fontFamily: 'var(--font-body)',
      animation: 'paysys-fade-in var(--duration-standard) var(--ease-standard)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--fs-body-md)',
      color: 'var(--color-text-primary)'
    }
  }, title), message && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--fs-body-sm)',
      color: 'var(--color-text-secondary)',
      marginTop: 2
    }
  }, message)), onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    "aria-label": "Close",
    style: {
      border: 'none',
      background: 'none',
      cursor: 'pointer',
      color: 'var(--slate-500)',
      fontSize: 16,
      lineHeight: 1
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
const SIDE_STYLE = {
  top: {
    bottom: '100%',
    left: '50%',
    transform: 'translate(-50%, -8px)'
  },
  bottom: {
    top: '100%',
    left: '50%',
    transform: 'translate(-50%, 8px)'
  },
  left: {
    right: '100%',
    top: '50%',
    transform: 'translate(-8px, -50%)'
  },
  right: {
    left: '100%',
    top: '50%',
    transform: 'translate(8px, -50%)'
  }
};
function Tooltip({
  label,
  children,
  side = 'top'
}) {
  const [open, setOpen] = React.useState(false);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-flex'
    },
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false)
  }, children, open && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      ...SIDE_STYLE[side],
      padding: '6px 10px',
      background: 'var(--navy-900)',
      color: 'var(--white)',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-caption)',
      borderRadius: 'var(--radius-sm)',
      whiteSpace: 'nowrap',
      boxShadow: 'var(--shadow-md)',
      zIndex: 20,
      animation: 'paysys-fade-in var(--duration-fast) var(--ease-standard)'
    }
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function Checkbox({
  label,
  checked = false,
  onChange,
  disabled = false
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-body-md)',
      color: 'var(--color-text-primary)'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: checked,
    onChange: onChange,
    disabled: disabled,
    style: {
      position: 'absolute',
      opacity: 0,
      width: 0,
      height: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      borderRadius: 'var(--radius-sm)',
      flexShrink: 0,
      border: `1.5px solid ${checked ? 'var(--blue-600)' : 'var(--color-border-strong)'}`,
      background: checked ? 'var(--blue-600)' : 'var(--white)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background var(--duration-fast) var(--ease-standard)'
    }
  }, checked && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--white)',
      fontSize: 12,
      lineHeight: 1,
      fontWeight: 'var(--weight-bold)'
    }
  }, "\u2713")), label);
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function Input(props) {
  const {
    label,
    placeholder,
    value,
    onChange,
    type = 'text',
    error,
    hint,
    disabled = false,
    required = false,
    icon = null,
    id
  } = props;
  const [focused, setFocused] = React.useState(false);
  const inputId = id || label ? `in-${(label || placeholder || 'field').replace(/\s+/g, '-').toLowerCase()}` : undefined;
  const borderColor = error ? 'var(--danger-600)' : focused ? 'var(--blue-600)' : 'var(--color-border)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontFamily: 'var(--font-body)',
      width: '100%'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: inputId,
    style: {
      fontSize: 'var(--fs-body-sm)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--color-text-primary)'
    }
  }, label, required && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--danger-600)'
    }
  }, " *")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center'
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: 12,
      width: 16,
      height: 16,
      color: 'var(--slate-500)',
      display: 'inline-flex'
    }
  }, icon), /*#__PURE__*/React.createElement("input", {
    id: inputId,
    type: type,
    placeholder: placeholder,
    value: value,
    onChange: onChange,
    disabled: disabled,
    required: required,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: icon ? '10px 12px 10px 36px' : '10px 12px',
      fontSize: 'var(--fs-body-md)',
      fontFamily: 'var(--font-body)',
      color: 'var(--color-text-primary)',
      border: `1.5px solid ${borderColor}`,
      borderRadius: 'var(--radius-md)',
      background: disabled ? 'var(--slate-50)' : 'var(--white)',
      outline: 'none',
      boxShadow: focused ? 'var(--shadow-focus)' : 'none',
      transition: 'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)'
    }
  })), (error || hint) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-caption)',
      color: error ? 'var(--danger-600)' : 'var(--color-text-muted)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
function Radio({
  label,
  name,
  options = [],
  value,
  onChange,
  disabled = false,
  direction = 'vertical'
}) {
  return /*#__PURE__*/React.createElement("div", {
    role: "radiogroup",
    "aria-label": label,
    style: {
      display: 'flex',
      flexDirection: direction === 'horizontal' ? 'row' : 'column',
      gap: direction === 'horizontal' ? 20 : 10
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-body-sm)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--color-text-primary)',
      marginBottom: 2
    }
  }, label), options.map(opt => {
    const checked = value === opt.value;
    return /*#__PURE__*/React.createElement("label", {
      key: opt.value,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--fs-body-md)',
        color: 'var(--color-text-primary)'
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "radio",
      name: name,
      value: opt.value,
      checked: checked,
      disabled: disabled,
      onChange: () => onChange && onChange(opt.value),
      style: {
        position: 'absolute',
        opacity: 0,
        width: 0,
        height: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 18,
        height: 18,
        borderRadius: '50%',
        flexShrink: 0,
        border: `1.5px solid ${checked ? 'var(--blue-600)' : 'var(--color-border-strong)'}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--white)'
      }
    }, checked && /*#__PURE__*/React.createElement("span", {
      style: {
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: 'var(--blue-600)'
      }
    })), opt.label);
  }));
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function Select(props) {
  const {
    label,
    options = [],
    value,
    onChange,
    placeholder,
    error,
    hint,
    disabled = false,
    required = false
  } = props;
  const [focused, setFocused] = React.useState(false);
  const borderColor = error ? 'var(--danger-600)' : focused ? 'var(--blue-600)' : 'var(--color-border)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontFamily: 'var(--font-body)',
      width: '100%'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 'var(--fs-body-sm)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--color-text-primary)'
    }
  }, label, required && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--danger-600)'
    }
  }, " *")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: value,
    onChange: onChange,
    disabled: disabled,
    required: required,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '10px 36px 10px 12px',
      appearance: 'none',
      fontSize: 'var(--fs-body-md)',
      fontFamily: 'var(--font-body)',
      color: value ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
      border: `1.5px solid ${borderColor}`,
      borderRadius: 'var(--radius-md)',
      background: disabled ? 'var(--slate-50)' : 'var(--white)',
      outline: 'none',
      boxShadow: focused ? 'var(--shadow-focus)' : 'none',
      cursor: disabled ? 'not-allowed' : 'pointer'
    }
  }, placeholder && /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true,
    hidden: true
  }, placeholder), options.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label))), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: 12,
      top: '50%',
      transform: 'translateY(-50%)',
      color: 'var(--slate-500)',
      fontSize: 12,
      pointerEvents: 'none'
    }
  }, "\u25BE")), (error || hint) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--fs-caption)',
      color: error ? 'var(--danger-600)' : 'var(--color-text-muted)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
const TRACK_W = {
  sm: 32,
  md: 40
};
const TRACK_H = {
  sm: 18,
  md: 22
};
function Switch({
  label,
  checked = false,
  onChange,
  disabled = false,
  size = 'md'
}) {
  const w = TRACK_W[size] || TRACK_W.md;
  const h = TRACK_H[size] || TRACK_H.md;
  const knob = h - 4;
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--fs-body-md)',
      color: 'var(--color-text-primary)'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    role: "switch",
    "aria-checked": checked,
    checked: checked,
    onChange: onChange,
    disabled: disabled,
    style: {
      position: 'absolute',
      opacity: 0,
      width: 0,
      height: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: w,
      height: h,
      borderRadius: 'var(--radius-pill)',
      flexShrink: 0,
      position: 'relative',
      background: checked ? 'var(--blue-600)' : 'var(--slate-300)',
      transition: 'background var(--duration-standard) var(--ease-standard)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 2,
      left: checked ? w - knob - 2 : 2,
      width: knob,
      height: knob,
      borderRadius: '50%',
      background: 'var(--white)',
      boxShadow: 'var(--shadow-sm)',
      transition: 'left var(--duration-standard) var(--ease-standard)'
    }
  })), label);
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function Tabs({
  tabs = [],
  activeId,
  defaultTabId,
  onChange
}) {
  const [internalActive, setInternalActive] = React.useState(defaultTabId || tabs[0] && tabs[0].id);
  const current = activeId !== undefined ? activeId : internalActive;
  const setCurrent = id => {
    onChange ? onChange(id) : setInternalActive(id);
  };
  const activeTab = tabs.find(t => t.id === current);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    style: {
      display: 'flex',
      gap: 4,
      borderBottom: '1.5px solid var(--color-border)'
    }
  }, tabs.map(t => {
    const active = t.id === current;
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      role: "tab",
      "aria-selected": active,
      onClick: () => setCurrent(t.id),
      style: {
        padding: '10px 16px',
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        position: 'relative',
        fontFamily: 'var(--font-body)',
        fontWeight: 'var(--weight-semibold)',
        fontSize: 'var(--fs-body-md)',
        color: active ? 'var(--blue-600)' : 'var(--color-text-secondary)'
      }
    }, t.label, active && /*#__PURE__*/React.createElement("span", {
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: -1.5,
        height: 2.5,
        background: 'var(--blue-600)',
        borderRadius: 2
      }
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 4px',
      color: 'var(--color-text-secondary)',
      fontSize: 'var(--fs-body-md)',
      lineHeight: 'var(--lh-body-md)'
    }
  }, activeTab && activeTab.content));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Dialog.jsx
try { (() => {
const SIZES = {
  sm: 380,
  md: 480,
  lg: 640
};
function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md'
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(10,37,64,0.55)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      animation: 'paysys-fade-in var(--duration-fast) var(--ease-standard)'
    },
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      width: SIZES[size] || SIZES.md,
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100vh - 64px)',
      overflow: 'auto',
      background: 'var(--white)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-lg)',
      animation: 'paysys-pop-in var(--duration-standard) var(--ease-standard)',
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '18px 24px',
      borderBottom: '1px solid var(--color-border)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--fs-h3)',
      color: 'var(--color-text-primary)'
    }
  }, title), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    "aria-label": "Close",
    style: {
      border: 'none',
      background: 'none',
      cursor: 'pointer',
      fontSize: 20,
      lineHeight: 1,
      color: 'var(--slate-500)'
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px',
      color: 'var(--color-text-secondary)',
      fontSize: 'var(--fs-body-md)',
      lineHeight: 'var(--lh-body-md)'
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 24px',
      borderTop: '1px solid var(--color-border)',
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 10,
      background: 'var(--color-bg-subtle)'
    }
  }, footer)));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Dialog.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.ProcessSteps = __ds_scope.ProcessSteps;

__ds_ns.StatMetric = __ds_scope.StatMetric;

__ds_ns.FlowDiagram = __ds_scope.FlowDiagram;

__ds_ns.Alert = __ds_scope.Alert;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Dialog = __ds_scope.Dialog;

})();
