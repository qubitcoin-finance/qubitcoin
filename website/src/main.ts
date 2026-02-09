// Intersection observer for reveal animations
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible')
    }
  })
}, { threshold: 0.1 })

document.querySelectorAll('.reveal').forEach(el => observer.observe(el))


// Smooth nav highlight
const navLinks = document.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]')
const sections = document.querySelectorAll('section[id]')

window.addEventListener('scroll', () => {
  let current = ''
  sections.forEach(section => {
    const el = section as HTMLElement
    if (window.scrollY >= el.offsetTop - 200) {
      current = el.id
    }
  })
  navLinks.forEach(link => {
    link.classList.remove('text-qubit-400')
    link.classList.add('text-text-muted')
    if (link.getAttribute('href') === '#' + current) {
      link.classList.add('text-qubit-400')
      link.classList.remove('text-text-muted')
    }
  })
})
