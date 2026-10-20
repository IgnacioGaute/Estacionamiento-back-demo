import { Controller, Get, Post, Body, Patch, Param, Delete, Req, UseGuards, ForbiddenException, Query } from '@nestjs/common';
import { listPagination } from 'src/utils/list-pagination';
import { FiltrosAvisos, NotesService } from './notes.service';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { Paginate, PaginateQuery } from 'nestjs-paginate';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';

@Controller('notes')
@UseGuards(AuthOrTokenAuthGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Post('users/:userId')
  create(@Req() req: any, @Param('userId') userId: string, @Body() createNoteDto: CreateNoteDto) {
    if (userId !== req.user.userId) throw new ForbiddenException('El autor debe ser el usuario autenticado.');
    return this.notesService.create(createNoteDto, userId);
  }

  @Get()
  findAll(
    @Paginate() query: PaginateQuery,
    @Req() req: any,
    @Query('estado') estado?: FiltrosAvisos['estado'],
    @Query('origen') origen?: FiltrosAvisos['origen'],
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('autor') autor?: string,
  ) {
    return this.notesService.findAll(query, req.user.userId, { estado, origen, desde, hasta, autor });
  }
  @Get('unread')
  unread(@Req() req: any) {
    return this.notesService.unread(req.user.userId);
  }

  @Post('read-all')
  markAllRead(@Req() req: any) {
    return this.notesService.markAllRead(req.user.userId);
  }

  @Post(':id/read')
  markRead(@Req() req: any, @Param('id') id: string) {
    return this.notesService.markRead(id, req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.notesService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateNoteDto: UpdateNoteDto) {
    return this.notesService.update(id, updateNoteDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.notesService.remove(id);
  }

  @Get('today/:userId')
  async getTodayNotes(@Param('userId') userId: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.notesService.getTodayNotes(userId, listPagination(page, limit));
  }
}
