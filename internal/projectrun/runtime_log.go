package projectrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
)

const (
	RuntimeSupervisorCommandName      = "__runtime-supervisor"
	runtimeLogLimit                   = int64(64 << 10)
	runtimeErrorTailLimit             = int64(4 << 10)
	runtimeSupervisorRequestLimit     = int64(1 << 20)
	runtimeSupervisorHandshakeTimeout = 15 * time.Second
	runtimeSupervisorShutdownGrace    = 2 * time.Second
)

type runtimeSupervisorRequest struct {
	Command Command `json:"command"`
}

type runtimeSupervisorAck struct {
	Started bool   `json:"started"`
	Error   string `json:"error,omitempty"`
}

func writeRuntimeSupervisorRequest(writer io.Writer, command Command) error {
	if err := json.NewEncoder(writer).Encode(runtimeSupervisorRequest{Command: command}); err != nil {
		return fmt.Errorf("send managed command to runtime supervisor: %w", err)
	}
	return nil
}

func readRuntimeSupervisorRequest(reader io.Reader) (Command, error) {
	decoder := json.NewDecoder(io.LimitReader(reader, runtimeSupervisorRequestLimit))
	decoder.DisallowUnknownFields()
	request := runtimeSupervisorRequest{}
	if err := decoder.Decode(&request); err != nil {
		return Command{}, fmt.Errorf("read managed command from runtime supervisor pipe: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			err = fmt.Errorf("multiple JSON values")
		}
		return Command{}, fmt.Errorf("reject trailing runtime supervisor input: %w", err)
	}
	return request.Command, nil
}

func writeRuntimeSupervisorAck(writer io.Writer, ack runtimeSupervisorAck) error {
	return json.NewEncoder(writer).Encode(ack)
}

func readRuntimeSupervisorAck(reader io.Reader) (runtimeSupervisorAck, error) {
	ack := runtimeSupervisorAck{}
	if err := json.NewDecoder(reader).Decode(&ack); err != nil {
		return runtimeSupervisorAck{}, fmt.Errorf("read runtime supervisor acknowledgement: %w", err)
	}
	return ack, nil
}

// SuperviseRuntime starts the managed command only after the parent has
// persisted this supervisor's identity and sent the command over reader.
func SuperviseRuntime(ctx context.Context, reader io.Reader, acknowledgements io.Writer, path string) error {
	file, err := managedOutput(path)
	if err != nil {
		err = fmt.Errorf("open managed runtime log: %w", err)
		_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Error: err.Error()})
		return err
	}
	defer file.Close()
	return superviseRuntime(ctx, reader, acknowledgements, file)
}

// SuperviseRuntimeWithInheritedLog uses descriptor 3 inherited from the
// ownership-checking parent. It never resolves a filesystem path.
func SuperviseRuntimeWithInheritedLog(ctx context.Context, reader io.Reader, acknowledgements io.Writer) error {
	file := os.NewFile(3, "workspace-runtime.log")
	if file == nil {
		return fmt.Errorf("inherited managed runtime log is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("inherited managed runtime log is not a private regular file")
	}
	return superviseRuntime(ctx, reader, acknowledgements, file)
}

func superviseRuntime(ctx context.Context, reader io.Reader, acknowledgements io.Writer, file *os.File) error {
	if group := syscall.Getpgrp(); group != os.Getpid() {
		err := fmt.Errorf("runtime supervisor PID %d is not its process-group leader", os.Getpid())
		_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Error: err.Error()})
		return err
	}
	requestClosed := make(chan struct{})
	if closer, ok := reader.(io.Closer); ok {
		go func() {
			select {
			case <-ctx.Done():
				_ = closer.Close()
			case <-requestClosed:
			}
		}()
	}
	command, err := readRuntimeSupervisorRequest(reader)
	close(requestClosed)
	if err != nil {
		_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Error: err.Error()})
		return err
	}
	cmd, err := prepareCommand(command)
	if err != nil {
		_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Error: err.Error()})
		return err
	}
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		err = fmt.Errorf("create managed runtime output pipe: %w", err)
		_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Error: err.Error()})
		return err
	}
	defer outputReader.Close()
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = outputWriter, outputWriter
	if err := cmd.Start(); err != nil {
		_ = outputWriter.Close()
		err = fmt.Errorf("start %q: %w", command.Argv[0], err)
		_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Error: err.Error()})
		return err
	}
	_ = outputWriter.Close()
	go func() { _ = cmd.Wait() }()
	// A failed acknowledgement means the parent disappeared or will terminate
	// this persisted process group. The supervisor must remain the group leader.
	_ = writeRuntimeSupervisorAck(acknowledgements, runtimeSupervisorAck{Started: true})

	closed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = outputReader.Close()
		case <-closed:
		}
	}()
	err = copyBoundedLog(file, outputReader)
	close(closed)
	if ctx.Err() != nil {
		return terminateSupervisedRuntime(ctx)
	}
	// Even after the managed command exits (or log draining fails), remain alive
	// as the persisted process-group leader until explicit cleanup.
	<-ctx.Done()
	return errors.Join(terminateSupervisedRuntime(ctx), err)
}

func terminateSupervisedRuntime(ctx context.Context) error {
	group := syscall.Getpgrp()
	if group != os.Getpid() {
		return errors.Join(ctx.Err(), fmt.Errorf(
			"refusing to stop runtime process group %d from non-leader PID %d",
			group, os.Getpid(),
		))
	}
	if err := syscall.Kill(-group, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return errors.Join(ctx.Err(), fmt.Errorf("stop supervised runtime process group %d: %w", group, err))
	}
	timer := time.NewTimer(runtimeSupervisorShutdownGrace)
	defer timer.Stop()
	<-timer.C
	if err := syscall.Kill(-group, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return errors.Join(ctx.Err(), fmt.Errorf("kill supervised runtime process group %d: %w", group, err))
	}
	return ctx.Err()
}

func copyBoundedLog(file *os.File, reader io.Reader) error {
	buffer := make([]byte, 32<<10)
	var size int64
	for {
		read, readErr := reader.Read(buffer)
		if read > 0 {
			written, err := file.Write(buffer[:read])
			if err != nil {
				return fmt.Errorf("write managed runtime log: %w", err)
			}
			size += int64(written)
			if size > runtimeLogLimit*2 {
				compacted, err := compactRuntimeLog(file, size)
				if err != nil {
					return err
				}
				size = compacted
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, os.ErrClosed) {
				return nil
			}
			return fmt.Errorf("read managed runtime output: %w", readErr)
		}
	}
}

func compactRuntimeLog(file *os.File, size int64) (int64, error) {
	tailSize := min(size, runtimeLogLimit)
	tail := make([]byte, tailSize)
	if _, err := file.ReadAt(tail, size-tailSize); err != nil {
		return size, fmt.Errorf("read managed runtime log tail: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return size, fmt.Errorf("rewind managed runtime log: %w", err)
	}
	if _, err := file.Write(tail); err != nil {
		return size, fmt.Errorf("compact managed runtime log: %w", err)
	}
	if err := file.Truncate(tailSize); err != nil {
		return size, fmt.Errorf("truncate managed runtime log: %w", err)
	}
	if _, err := file.Seek(0, io.SeekEnd); err != nil {
		return size, fmt.Errorf("seek managed runtime log end: %w", err)
	}
	return tailSize, nil
}

func readRuntimeLogTail(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		return ""
	}
	size := min(info.Size(), runtimeErrorTailLimit)
	buffer := make([]byte, size)
	if _, err := file.ReadAt(buffer, info.Size()-size); err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	return sanitizeRuntimeLog(string(buffer))
}

func sanitizeRuntimeLog(value string) string {
	value = strings.Map(func(character rune) rune {
		if character == '\n' || character == '\t' || character >= ' ' {
			return character
		}
		return -1
	}, value)
	return strings.TrimSpace(value)
}
