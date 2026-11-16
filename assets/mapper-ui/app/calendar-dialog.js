
(function(){
  function fixCalendarPickerDialog(){
    var popover = document.getElementById('calendarPopover');
    var grid = popover && popover.querySelector('.calendar-popover-grid');
    var close = document.getElementById('calendarPopoverCloseBtn');
    if (!popover || !grid) return;
    if (popover.parentElement !== document.body) document.body.appendChild(popover);
    if (close && close.parentElement !== grid) grid.prepend(close);
    if (!popover.dataset.pjCloseWired) {
      popover.dataset.pjCloseWired = '1';
      popover.addEventListener('click', function(e){
        if (e.target === popover) {
          var btn = document.getElementById('calendarPopoverCloseBtn');
          if (btn) btn.click();
          else popover.classList.remove('open');
        }
      }, true);
    }
  }
  document.addEventListener("DOMContentLoaded", fixCalendarPickerDialog, { once: true });
})();
