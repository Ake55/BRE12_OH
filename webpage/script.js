const toggle = document.getElementById("panelToggle");
const panel = document.getElementById("sidePanel");
const overlay = document.getElementById("panelOverlay");
const toggleText = toggle.querySelector(".panel-toggle__text");

panel.inert = true;

function setPanel(open, restoreFocus = false) {
  document.body.classList.toggle("panel-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Close project menu" : "Open project menu");
  toggleText.textContent = open ? "Close" : "Menu";
  panel.setAttribute("aria-hidden", String(!open));
  overlay.setAttribute("aria-hidden", String(!open));
  panel.inert = !open;

  if (open) {
    panel.querySelector(".side-nav a")?.focus();
  } else if (restoreFocus) {
    toggle.focus();
  }
}

toggle.addEventListener("click", () => {
  setPanel(!document.body.classList.contains("panel-open"));
});

overlay.addEventListener("click", () => {
  setPanel(false, true);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("panel-open")) {
    setPanel(false, true);
  }
});

panel.querySelectorAll(".side-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    setPanel(false, true);
  });
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
);

document.querySelectorAll(".reveal").forEach((element) => {
  revealObserver.observe(element);
});
