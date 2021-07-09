define("qtype_coderunner/ui_ace_gapfiller", ['jquery'], function($) {

    const Range = ace.require("ace/range").Range;
    const fillChar = " ";
    const validChars = /[ !"#$%&'()*+`\-./0-9:;<=>?@A-Z\[\]\\^_a-z{}|~]/;

    function AceGapfillerUi(textareaId, w, h, uiParams) {
        // Constructor for the Ace interface object

        this.textArea = $(document.getElementById(textareaId));
        var wrapper = $(document.getElementById(textareaId + '_wrapper')),
            focused = this.textArea[0] === document.activeElement,
            lang = uiParams.lang,
            session,
            t = this;  // For embedded callbacks.

        let code = "";
        this.uiParams = uiParams;
        this.source = uiParams.ui_source || 'globalextra';
        if (this.source !== 'globalextra' && this.source !== 'test0') {
            alert('Invalid source for code in ui_ace_gapfiller');
            this.source = 'globalextra';
        }
        if (this.source == 'globalextra') {
            code = this.textArea.attr('data-globalextra');
        } else {
            code = this.textArea.attr('data-test0');
        }
        
        try {
            window.ace.require("ace/ext/language_tools");
            this.modelist = window.ace.require('ace/ext/modelist');

            this.enabled = false;
            this.contents_changed = false;
            this.capturingTab = false;
            this.clickInProgress = false;

            this.editNode = $("<div></div>"); // Ace editor manages this
            this.editNode.css({
                resize: 'none',
                height: h,
                width: "100%"
            });

            this.editor = window.ace.edit(this.editNode.get(0));
            if (this.textArea.prop('readonly')) {
                this.editor.setReadOnly(true);
            }

            this.editor.setOptions({
                displayIndentGuides: false,
                dragEnabled: false,
                enableBasicAutocompletion: true,
                newLineMode: "unix",
            });
            this.editor.$blockScrolling = Infinity;

            session = this.editor.getSession();

            // Set theme if available (not currently enabled).
            if (uiParams.theme) {
                this.editor.setTheme("ace/theme/" + uiParams.theme);
            }

            this.setLanguage(lang);

            this.setEventHandlers(this.textArea);
            this.captureTab();

            // Try to tell Moodle about parts of the editor with z-index.
            // It is hard to be sure if this is complete. ACE adds all its CSS using JavaScript.
            // Here, we just deal with things that are known to cause a problem.
            // Can't do these operations until editor has rendered. So ...
            this.editor.renderer.on('afterRender', function() {
                var gutter =  wrapper.find('.ace_gutter');
                if (gutter.hasClass('moodle-has-zindex')) {
                    return;  // So we only do what follows once.
                }
                gutter.addClass('moodle-has-zindex');

                if (focused) {
                    t.editor.focus();
                    t.editor.navigateFileEnd();
                }
                t.aceLabel = wrapper.find('.answerprompt');
                t.aceLabel.attr('for', 'ace_' + textareaId);

                t.aceTextarea = wrapper.find('.ace_text-input');
                t.aceTextarea.attr('id', 'ace_' + textareaId);
            });

            this.createGaps(code);

            // Intercept commands sent to ace.
            this.editor.commands.on("exec", function(e) { 
                let cursor = t.editor.selection.getCursor();
                let commandName = e.command.name;
                selectionRange = t.editor.getSelectionRange();

                let gap = t.findCursorGap(cursor);

                if (commandName.startsWith("go")) {  // If command just moves the cursor then do nothing.
                    if (gap != null && commandName === "gotoright" && cursor.column === gap.range.start.column+gap.textSize) {
                        // In this case we jump out of gap over the empty space that contains nothing that the user has entered.
                        t.editor.moveCursorTo(cursor.row, gap.range.end.column+1);
                    } else {
                        return;
                    }   
                }

                if (gap === null) {
                    // Not in a gap
                } else if (t.editor.selection.isEmpty()) {
                    // User is not selecting multiple characters.
                    if (commandName === "insertstring") {
                        let char = e.args;
                        // Only allow user to insert 'valid' chars.
                        if (validChars.test(char)) {    
                            gap.insertChar(t.gaps, cursor, char);
                        }
                    } else if (commandName === "backspace") {
                        // Only delete chars that are actually in the gap.
                        if (cursor.column > gap.range.start.column && gap.textSize > 0) {
                            gap.deleteChar(t.gaps, {row: cursor.row, column: cursor.column-1});
                        }
                    } else if (commandName === "del") {
                        // Only delete chars that are actually in the gap.
                        if (cursor.column < gap.range.start.column + gap.textSize && gap.textSize > 0) {
                            gap.deleteChar(t.gaps, cursor);
                        }
                    }
                    t.editor.selection.clearSelection(); // Keep selection clear.
                }
                e.preventDefault();
                e.stopPropagation();    
            });

            // Move cursor to where it should be if we click on a gap.
            t.editor.selection.on('changeCursor', function() {
                let cursor = t.editor.selection.getCursor();
                let gap = t.findCursorGap(cursor);
                if (gap != null) {
                    if (cursor.column > gap.range.start.column+gap.textSize) {
                        t.editor.moveCursorTo(gap.range.start.row, gap.range.start.column+gap.textSize);
                    }
                }
            });

            this.fail = false;
            this.reload();
        }
        catch(err) {
            // Something ugly happened. Probably ace editor hasn't been loaded
            this.fail = true;
            console.log(err);
        }
    }

    // Do not call until after this.editor has been instantiated.
    AceGapfillerUi.prototype.createGaps = function(code) {
        this.gaps = [];
        // Extract gaps from source code and insert gaps into editor.
        function reEscape(s) {
            var c, specials = '{[(*+\\', result='';
            for (var i = 0; i < s.length; i++) {
                c = s[i];
                for (var j = 0; j < specials.length; j++) {
                    if (c === specials[j]) {
                        c = '\\' + c;
                    }
                }
                result += c;
            }
            return result;
        }

        let lines = code.split(/\r?\n/);

        let sepLeft = reEscape('{[');
        let sepRight = reEscape(']}');
        let splitter = new RegExp(sepLeft + ' *((?:\\d+)|(?:\\d+- *\\d+)) *' + sepRight);

        let editorContent = "";
        for (let i = 0; i < lines.length; i++) {
            let bits = lines[i].split(splitter);
            editorContent += bits[0];
            
            let columnPos = bits[0].length;
            for (let j = 1; j < bits.length; j += 2) {
                let values = bits[j].split('-');
                let minWidth = parseInt(values[0]);
                let maxWidth = (values.length > 1 ? parseInt(values[1]) : Infinity);
            
                // Create new gap.
                this.gaps.push(new Gap(this.editor, i, columnPos, minWidth, maxWidth));
                columnPos += minWidth;
                editorContent += ' '.repeat(minWidth);
                if (j + 1 < bits.length) {
                    editorContent += bits[j+1];
                    columnPos += bits[j+1].length;
                }
                
            }

            if (i < lines.length-1) {
                editorContent += '\n';
            }
        }
        this.editor.session.setValue(editorContent);
    }

    // Return the gap that the cursor is in. This will acutally return a gap if the cursor is 1 outside the gap
    // as this will be needed for backspace/insertion to work. Rigth now this is done as a simple
    // linear search but could be improved later. Returns null if the cursor is not in a gap.
    AceGapfillerUi.prototype.findCursorGap = function(cursor) {
        for (let gap of this.gaps) {
            if (gap.cursorInGap(cursor)) {
                return gap;
            }
        }
        return null;
    }

    AceGapfillerUi.prototype.failed = function() {
        return this.fail;
    };

    AceGapfillerUi.prototype.failMessage = function() {
        return 'ace_ui_notready';
    };


    // Sync to TextArea
    AceGapfillerUi.prototype.sync = function() {
        let serialisation = [];  // A list of field values.
        let empty = true;

        for (let gap of this.gaps) {
            let value = gap.getText();
            serialisation.push(value);
            if (value !== "") {
                empty = false;
            }
        }
        if (empty) {
            this.textArea.val('');
        } else {
            this.textArea.val(JSON.stringify(serialisation));
        }
    };

    // Reload the HTML fields from the given serialisation.
    AceGapfillerUi.prototype.reload = function() {
        let content = this.textArea.val();
        if (content) {
            try {
                values = JSON.parse(content);
                for (let i = 0; i < this.gaps.length; i++) {
                    value = i < values.length ? values[i]: '???';
                    for (let char of value) {
                        this.gaps[i].insertChar(this.gaps, {row: this.gaps[i].range.start.row, column: this.gaps[i].range.start.column+this.gaps[i].textSize}, char);
                    }
                }
            } catch(e) {
                // Just ignore errors
            }
        }
    }

    AceGapfillerUi.prototype.setLanguage = function(language) {
        var session = this.editor.getSession(),
            mode = this.findMode(language);
        if (mode) {
            session.setMode(mode.mode);
        }
    };

    AceGapfillerUi.prototype.getElement = function() {
        return this.editNode;
    };

    AceGapfillerUi.prototype.captureTab = function () {
        this.capturingTab = true;
        this.editor.commands.bindKeys({'Tab': 'indent', 'Shift-Tab': 'outdent'});
    };

    AceGapfillerUi.prototype.releaseTab = function () {
        this.capturingTab = false;
        this.editor.commands.bindKeys({'Tab': null, 'Shift-Tab': null});
    };

    AceGapfillerUi.prototype.setEventHandlers = function () {
        var TAB = 9,
            ESC = 27,
            KEY_M = 77,
            t = this;

        this.editor.getSession().on('change', function() {
            t.contents_changed = true;
        });

        this.editor.on('blur', function() {
            if (t.contents_changed) {
                t.textArea.trigger('change');
            }
        });

        this.editor.on('mousedown', function() {
            // Event order seems to be (\ is where the mouse button is pressed, / released):
            // Chrome: \ mousedown, mouseup, focusin / click.
            // Firefox/IE: \ mousedown, focusin / mouseup, click.
            t.clickInProgress = true;
        });

        this.editor.on('focus', function() {
            if (t.clickInProgress) {
                t.captureTab();
            } else {
                t.releaseTab();
            }
        });

        this.editor.on('click', function() {
            t.clickInProgress = false;
        });

        this.editor.container.addEventListener('keydown', function(e) {
            if (e.which === undefined || e.which !== 0) { // Normal keypress?
                if (e.keyCode === KEY_M && e.ctrlKey && !e.altKey) {
                    if (t.capturingTab) {
                        t.releaseTab();
                    } else {
                        t.captureTab();
                    }
                    e.preventDefault(); // Firefox uses this for mute audio in current browser tab.
                }
                else if (e.keyCode === ESC) {
                    t.releaseTab();
                }
                else if (!(e.shiftKey || e.ctrlKey || e.altKey || e.keyCode == TAB)) {
                    t.captureTab();
                }
            }
        }, true);
    };

    AceGapfillerUi.prototype.destroy = function () {
        this.sync();
        var focused;
        if (!this.fail) {
            // Proceed only if this wrapper was correctly constructed
            focused = this.editor.isFocused();
            this.editor.destroy();
            $(this.editNode).remove();
            if (focused) {
                this.textArea.focus();
                this.textArea[0].selectionStart = this.textArea[0].value.length;
            }
        }
    };

    AceGapfillerUi.prototype.hasFocus = function() {
        return this.editor.isFocused();
    };

    AceGapfillerUi.prototype.findMode = function (language) {
        var candidate,
            filename,
            result,
            candidates = [], // List of candidate modes.
            nameMap = {
                'octave': 'matlab',
                'nodejs': 'javascript',
                'c#': 'cs'
            };

        if (typeof language !== 'string') {
            return undefined;
        }
        if (language.toLowerCase() in nameMap) {
            language = nameMap[language.toLowerCase()];
        }

        candidates = [language, language.replace(/\d+$/, "")];
        for (var i = 0; i < candidates.length; i++) {
            candidate = candidates[i];
            filename = "input." + candidate;
            result = this.modelist.modesByName[candidate] ||
                this.modelist.modesByName[candidate.toLowerCase()] ||
                this.modelist.getModeForPath(filename) ||
                this.modelist.getModeForPath(filename.toLowerCase());

            if (result && result.name !== 'text') {
                return result;
            }
        }
        return undefined;
    };

    AceGapfillerUi.prototype.resize = function(w, h) {
        this.editNode.outerHeight(h);
        this.editNode.outerWidth(w);
        this.editor.resize();
    };

    function Gap(editor, row, column, minWidth, maxWidth=Infinity) {
        this.editor = editor;
    
        this.minWidth = minWidth;
        this.maxWidth = maxWidth;
    
        this.range = new Range(row, column, row, column+minWidth);
        this.textSize = 0;
    
        // Create markers
        this.editor.session.addMarker(this.range, "ace-gap-outline", "text", true);
        this.editor.session.addMarker(this.range, "ace-gap-background", "text", false);
    }
    
    Gap.prototype.cursorInGap = function(cursor) {
        return (cursor.row >= this.range.start.row && cursor.column >= this.range.start.column  && 
            cursor.row <= this.range.end.row && cursor.column <= this.range.end.column);
    }
    
    Gap.prototype.getWidth = function() {
        return (this.range.end.column-this.range.start.column);
    }
    
    Gap.prototype.changeWidth = function(gaps, delta) {
        this.range.end.column += delta;
    
        // Update any gaps that come after this one on the same line.
        for (let other of gaps) {
            if (other.range.start.row === this.range.start.row && other.range.start.column > this.range.end.column) {
                other.range.start.column += delta;
                other.range.end.column += delta;
            }
        }
    
        this.editor.$onChangeBackMarker();
        this.editor.$onChangeFrontMarker();
    }
    
    Gap.prototype.insertChar = function(gaps, pos, char) {
        if (this.textSize === this.getWidth() && this.getWidth() < this.maxWidth) {    // Grow the size of gap and insert char.
            this.changeWidth(gaps, 1);
            this.textSize += 1;  // Important to record that texSize has increased before insertion.
            this.editor.session.insert(pos, char);
        } else if (this.textSize < this.maxWidth) {   // Insert char.
            this.editor.session.remove(new Range(pos.row, this.range.end.column-1, pos.row, this.range.end.column));
            this.textSize += 1;  // Important to record that texSize has increased before insertion.
            this.editor.session.insert(pos, char);
        }
    }
    
    Gap.prototype.deleteChar = function(gaps, pos) {
        this.textSize -= 1;
        this.editor.session.remove(new Range(pos.row, pos.column, pos.row, pos.column+1));
    
        if (this.textSize >= this.minWidth) {
            this.changeWidth(gaps, -1);  // Shrink the size of the gap.
        } else {
            this.editor.session.insert({row: pos.row, column: this.range.end.column-1}, fillChar); // Put new space at end so everything is shifted across.
        }
    }

    Gap.prototype.deleteRange = function(gaps, start, end) {
        for (let i = start; i < end; i++) {
            if (start < this.range.start.column+this.textSize) {
                this.deleteChar(gaps, {row: this.range.start.row, column: start});
            }
        }
    }
    
    Gap.prototype.insertText = function(gaps, start, text) {
        for (let i = 0; i < text.length; i++) {
            if (start+i < this.range.start.column+this.maxWidth) {
                this.insertChar(gaps, {row: this.range.start.row, column: start+i}, text[i]);
            }
        }
    }

    Gap.prototype.getText = function() {
        return this.editor.session.getTextRange(new Range(this.range.start.row, this.range.start.column, this.range.end.row, this.range.start.column+this.textSize));
    }

     return {
        Constructor: AceGapfillerUi
    };
});